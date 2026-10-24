const publicFilter = "s.visibility = 'public' AND s.review_status = 'approved' AND s.kind <> 'traditional_knowledge'";

function xml(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function xmlResponse(body) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/ http://www.openarchives.org/OAI/2.0/OAI-PMH.xsd"><responseDate>${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</responseDate>${body}</OAI-PMH>`, { headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

function date(value) {
  return new Date(value.replace(' ', 'T') + (value.endsWith('Z') ? '' : 'Z')).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function header(item, origin) {
  return `<header><identifier>${xml(`oai:${new URL(origin).host}:${item.id}`)}</identifier><datestamp>${date(item.reviewedAt)}</datestamp></header>`;
}

async function record(db, item, origin, identifierOnly) {
  const head = header(item, origin);
  if (identifierOnly) return head;
  const translations = (await db.prepare('SELECT language, title, abstract FROM submission_metadata WHERE submission_id = ? ORDER BY language').bind(item.id).all()).results;
  const fields = translations.map(translation => `<dc:title xml:lang="${xml(translation.language)}">${xml(translation.title)}</dc:title><dc:description xml:lang="${xml(translation.language)}">${xml(translation.abstract)}</dc:description>`).join('');
  return `<record>${head}<metadata><oai_dc:dc xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/oai_dc/ http://www.openarchives.org/OAI/2.0/oai_dc.xsd">${fields}<dc:identifier>${xml(`${origin}/api/submissions/${item.id}`)}</dc:identifier>${item.sourceUrl ? `<dc:relation>${xml(item.sourceUrl)}</dc:relation>` : ''}<dc:type>${xml(item.kind)}</dc:type><dc:language>${xml(item.primaryLanguage)}</dc:language></oai_dc:dc></metadata></record>`;
}

export async function oai(request, db, adminEmail) {
  const url = new URL(request.url);
  const params = url.searchParams;
  const verb = params.get('verb');
  const origin = url.origin;
  const endpoint = `${origin}/oai`;
  const base = `<request${verb ? ` verb="${xml(verb)}"` : ''}>${xml(endpoint)}</request>`;
  const error = (code, message) => xmlResponse(`${base}<error code="${code}">${xml(message)}</error>`);
  if (!verb || !['Identify', 'ListMetadataFormats', 'GetRecord', 'ListRecords', 'ListIdentifiers'].includes(verb)) return error('badVerb', 'Unsupported verb');
  const names = [...params.keys()];
  const allowed = verb === 'GetRecord' ? ['verb', 'identifier', 'metadataPrefix'] : verb === 'ListMetadataFormats' ? ['verb', 'identifier'] : ['ListRecords', 'ListIdentifiers'].includes(verb) ? ['verb', 'metadataPrefix', 'resumptionToken'] : ['verb'];
  if (names.some(name => !allowed.includes(name) || params.getAll(name).length !== 1)) return error('badArgument', 'Invalid arguments');
  if (verb === 'Identify') {
    const first = await db.prepare(`SELECT s.reviewed_at AS reviewedAt FROM submissions s WHERE ${publicFilter} ORDER BY s.reviewed_at ASC LIMIT 1`).bind().first();
    return xmlResponse(`${base}<Identify><repositoryName>Open Research Repository</repositoryName><baseURL>${xml(endpoint)}</baseURL><protocolVersion>2.0</protocolVersion><adminEmail>${xml(adminEmail)}</adminEmail><earliestDatestamp>${first ? date(first.reviewedAt) : '1970-01-01T00:00:00Z'}</earliestDatestamp><deletedRecord>no</deletedRecord><granularity>YYYY-MM-DDThh:mm:ssZ</granularity></Identify>`);
  }
  if (verb === 'ListMetadataFormats') {
    if (params.has('identifier')) {
      const prefix = `oai:${url.host}:`;
      const identifier = params.get('identifier');
      if (!identifier.startsWith(prefix)) return error('idDoesNotExist', 'Unknown identifier');
      const found = await db.prepare(`SELECT s.id FROM submissions s WHERE s.id = ? AND ${publicFilter}`).bind(identifier.slice(prefix.length)).first();
      if (!found) return error('idDoesNotExist', 'Unknown identifier');
    }
    return xmlResponse(`${base}<ListMetadataFormats><metadataFormat><metadataPrefix>oai_dc</metadataPrefix><schema>http://www.openarchives.org/OAI/2.0/oai_dc.xsd</schema><metadataNamespace>http://www.openarchives.org/OAI/2.0/oai_dc/</metadataNamespace></metadataFormat></ListMetadataFormats>`);
  }
  if (verb === 'GetRecord') {
    if (params.get('metadataPrefix') !== 'oai_dc' || !params.has('identifier')) return error('badArgument', 'identifier and oai_dc required');
    const prefix = `oai:${url.host}:`;
    const identifier = params.get('identifier');
    if (!identifier.startsWith(prefix)) return error('idDoesNotExist', 'Unknown identifier');
    const item = await db.prepare(`SELECT s.id, s.kind, s.primary_language AS primaryLanguage, s.source_url AS sourceUrl, s.reviewed_at AS reviewedAt FROM submissions s WHERE s.id = ? AND ${publicFilter}`).bind(identifier.slice(prefix.length)).first();
    return item ? xmlResponse(`${base}<GetRecord>${await record(db, item, origin, false)}</GetRecord>`) : error('idDoesNotExist', 'Unknown identifier');
  }
  let cursor = null;
  if (params.has('resumptionToken')) {
    const token = params.get('resumptionToken');
    if (params.has('metadataPrefix') || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) return error('badResumptionToken', 'Invalid token');
    try {
      cursor = JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/')));
    } catch { return error('badResumptionToken', 'Invalid token'); }
    if (cursor?.verb !== verb || typeof cursor.reviewedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cursor.reviewedAt) || typeof cursor.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(cursor.id)) return error('badResumptionToken', 'Invalid token');
  } else if (params.get('metadataPrefix') !== 'oai_dc') return error('badArgument', 'oai_dc required');
  const items = (await db.prepare(`SELECT s.id, s.kind, s.primary_language AS primaryLanguage, s.source_url AS sourceUrl, s.reviewed_at AS reviewedAt FROM submissions s WHERE ${publicFilter} ${cursor ? 'AND (s.reviewed_at > ? OR (s.reviewed_at = ? AND s.id > ?))' : ''} ORDER BY s.reviewed_at ASC, s.id ASC LIMIT 21`).bind(...(cursor ? [cursor.reviewedAt, cursor.reviewedAt, cursor.id] : [])).all()).results;
  if (!items.length && !cursor) return error('noRecordsMatch', 'No public records');
  if (!items.length) return error('badResumptionToken', 'Invalid token');
  const tag = verb;
  const contents = await Promise.all(items.slice(0, 20).map(item => record(db, item, origin, verb === 'ListIdentifiers')));
  const last = items[19];
  const nextToken = last && items.length > 20 ? btoa(JSON.stringify({ verb, reviewedAt: last.reviewedAt, id: last.id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '';
  const next = nextToken ? `<resumptionToken>${nextToken}</resumptionToken>` : '';
  return xmlResponse(`${base}<${tag}>${contents.join('')}${next}</${tag}>`);
}

export function linkedData(item, origin) {
  const primary = item.translations.find(entry => entry.language === item.primaryLanguage);
  return {
    '@context': 'https://schema.org',
    '@type': item.kind === 'dataset' ? 'Dataset' : 'ScholarlyArticle',
    '@id': `${origin}/api/submissions/${item.id}`,
    name: primary.title,
    description: primary.abstract,
    inLanguage: item.primaryLanguage,
    datePublished: item.reviewedAt,
    ...(item.sourceUrl ? { isBasedOn: item.sourceUrl } : {}),
    ...(item.sourceLicense ? { license: item.sourceLicense } : {})
  };
}
