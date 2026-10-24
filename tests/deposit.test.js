import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../src/index.js';

function environment() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0001_init_schema.sql', '0002_deposit_curation.sql', '0003_interoperability.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const objects = new Map();
  const DB = {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = sqlite.prepare(sql);
          return {
            async first() { return statement.get(...values) || null; },
            async all() { return { results: statement.all(...values) }; },
            async run() {
              const result = statement.run(...values);
              return { meta: { changes: Number(result.changes) } };
            }
          };
        }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return {
    DB,
    sqlite,
    CURATOR_SETUP_TOKEN: 'a'.repeat(48),
    OAI_ADMIN_EMAIL: 'admin@example.org',
    R2_BUCKET: {
      async put(key, body) { objects.set(key, body); },
      async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
      async delete(key) { objects.delete(key); }
    }
  };
}

async function api(env, path, { method = 'GET', body, token, contentType } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = contentType || 'application/json';
  if (contentType === 'application/pdf') headers['content-length'] = String(body.byteLength);
  const request = new Request(`https://example.invalid${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : contentType === 'application/pdf' ? body : JSON.stringify(body)
  });
  const response = await worker.fetch(request, env);
  return { response, data: response.headers.get('content-type')?.includes('json') ? await response.json() : null };
}

const credentials = { email: 'author@example.org', password: 'correct horse battery staple' };
const metadata = { kind: 'research', primaryLanguage: 'en', translations: [{ language: 'en', title: 'A study', abstract: 'Open methods' }] };

test('local accounts have revocable sessions and curator setup cannot be repeated', async () => {
  const env = environment();
  const registration = await api(env, '/api/auth/register', { method: 'POST', body: credentials });
  assert.equal(registration.response.status, 200);
  assert.equal(registration.data.user.role, 'author');
  assert.equal(env.sqlite.prepare('SELECT password_hash FROM local_credentials').get().password_hash.includes(credentials.password), false);
  const token = registration.data.token;
  assert.equal((await api(env, '/api/auth/me', { token })).data.user.email, credentials.email);
  assert.equal((await api(env, '/api/auth/me')).response.status, 401);
  assert.equal((await api(env, '/api/auth/bootstrap', { method: 'POST', body: { email: 'curator@example.org', password: credentials.password, setupToken: 'wrong' } })).response.status, 403);
  const curator = await api(env, '/api/auth/bootstrap', { method: 'POST', body: { email: 'curator@example.org', password: credentials.password, setupToken: env.CURATOR_SETUP_TOKEN } });
  assert.equal(curator.data.user.role, 'curator');
  assert.equal((await api(env, '/api/auth/bootstrap', { method: 'POST', body: { email: 'another@example.org', password: credentials.password, setupToken: env.CURATOR_SETUP_TOKEN } })).response.status, 403);
  assert.equal((await api(env, '/api/auth/logout', { method: 'POST', token })).response.status, 200);
  assert.equal((await api(env, '/api/auth/me', { token })).response.status, 401);
  const login = await api(env, '/api/auth/login', { method: 'POST', body: credentials });
  assert.equal(login.response.status, 200);
  assert.notEqual(login.data.token, token);
  for (let i = 0; i < 5; i++) {
    assert.equal((await api(env, '/api/auth/login', { method: 'POST', body: { ...credentials, password: 'incorrect password' } })).response.status, 401);
  }
  assert.equal((await api(env, '/api/auth/login', { method: 'POST', body: credentials })).response.status, 429);
  env.sqlite.close();
});

test('invalid metadata and traditional knowledge remain private, curator approves ordinary deposits only', async () => {
  const env = environment();
  const author = (await api(env, '/api/auth/register', { method: 'POST', body: credentials })).data.token;
  const curator = (await api(env, '/api/auth/bootstrap', { method: 'POST', body: { email: 'curator@example.org', password: credentials.password, setupToken: env.CURATOR_SETUP_TOKEN } })).data.token;
  assert.equal((await api(env, '/api/submissions', { method: 'POST', body: metadata })).response.status, 401);
  assert.equal((await api(env, '/api/submissions', { method: 'POST', body: { ...metadata, sourceUrl: 'javascript:alert(1)' }, token: author })).response.status, 400);
  assert.equal((await api(env, '/api/submissions', { method: 'POST', body: { ...metadata, translations: [{ language: 'en', title: ' ', abstract: '' }] }, token: author })).response.status, 400);
  assert.equal((await api(env, '/api/submissions', { method: 'POST', body: { ...metadata, kind: 'traditional_knowledge' }, token: author })).response.status, 400);
  const tk = await api(env, '/api/submissions', { method: 'POST', body: { ...metadata, kind: 'traditional_knowledge', consentAcknowledged: true }, token: author });
  assert.equal(tk.response.status, 201);
  assert.equal((await api(env, `/api/curation/submissions/${tk.data.id}/approve`, { method: 'POST', body: {}, token: curator })).response.status, 404);
  assert.equal((await api(env, `/api/submissions/${tk.data.id}`)).response.status, 404);
  assert.equal((await api(env, '/api/curation/submissions', { token: curator })).data.items.length, 0);
  assert.equal((await api(env, `/api/curation/submissions/${tk.data.id}`, { token: curator })).response.status, 404);
  const deposit = await api(env, '/api/submissions', { method: 'POST', body: metadata, token: author });
  assert.equal(deposit.response.status, 201);
  const id = deposit.data.id;
  assert.deepEqual([deposit.data.visibility, deposit.data.reviewStatus], ['private', 'pending']);
  assert.equal((await api(env, '/api/submissions')).data.items.length, 0);
  assert.equal((await api(env, `/api/submissions/${id}`)).response.status, 404);
  assert.equal((await api(env, '/api/me/submissions', { token: author })).data.items.length, 2);
  assert.equal((await api(env, '/api/curation/submissions', { token: author })).response.status, 403);
  assert.equal((await api(env, `/api/curation/submissions/${id}`)).response.status, 401);
  assert.equal((await api(env, `/api/curation/submissions/${id}`, { token: author })).response.status, 403);
  assert.equal((await api(env, `/api/curation/submissions/${id}`, { token: curator })).data.translations[0].abstract, 'Open methods');
  assert.equal((await api(env, `/api/curation/submissions/${id}`, { method: 'POST', token: curator })).response.status, 405);
  assert.equal((await api(env, `/api/curation/submissions/${id}/approve`, { method: 'POST', body: {}, token: author })).response.status, 403);
  const ownDeposit = await api(env, '/api/submissions', { method: 'POST', body: metadata, token: curator });
  assert.equal((await api(env, `/api/curation/submissions/${ownDeposit.data.id}/approve`, { method: 'POST', body: {}, token: curator })).response.status, 404);
  assert.equal((await api(env, `/api/curation/submissions/${ownDeposit.data.id}`, { token: curator })).response.status, 404);
  assert.equal((await api(env, `/api/curation/submissions/${id}/approve`, { method: 'POST', body: {}, token: curator })).response.status, 200);
  assert.equal((await api(env, `/api/curation/submissions/${id}`, { token: curator })).response.status, 404);
  assert.equal((await api(env, `/api/curation/submissions/${id}/approve`, { method: 'POST', body: {}, token: curator })).response.status, 404);
  assert.deepEqual((await api(env, '/api/submissions')).data.items.map(item => item.id), [id]);
  env.sqlite.close();
});

test('PDF uploads are private before approval and traditional knowledge stays unavailable publicly', async () => {
  const env = environment();
  const author = (await api(env, '/api/auth/register', { method: 'POST', body: credentials })).data.token;
  const curator = (await api(env, '/api/auth/bootstrap', { method: 'POST', body: { email: 'curator@example.org', password: credentials.password, setupToken: env.CURATOR_SETUP_TOKEN } })).data.token;
  const { data: { id } } = await api(env, '/api/submissions', { method: 'POST', body: metadata, token: author });
  const path = `/api/me/submissions/${id}/file`;
  const pdf = new TextEncoder().encode('%PDF-1.4\n%%EOF');
  assert.equal((await api(env, path, { method: 'PUT', body: new TextEncoder().encode('not-a-pdf'), token: author, contentType: 'application/pdf' })).response.status, 400);
  assert.equal((await api(env, path, { method: 'PUT', body: pdf, token: author, contentType: 'application/pdf' })).response.status, 200);
  assert.equal((await api(env, path, { method: 'PUT', body: pdf, token: author, contentType: 'application/pdf' })).response.status, 409);
  assert.equal((await api(env, `/api/submissions/${id}/file`)).response.status, 404);
  assert.equal((await api(env, path, { token: author })).response.headers.get('content-disposition'), 'attachment; filename="research.pdf"');
  await api(env, `/api/curation/submissions/${id}/approve`, { method: 'POST', body: {}, token: curator });
  assert.equal((await api(env, `/api/submissions/${id}/file`)).response.status, 200);
  const tk = await api(env, '/api/submissions', { method: 'POST', body: { ...metadata, kind: 'traditional_knowledge', consentAcknowledged: true }, token: author });
  assert.equal((await api(env, `/api/me/submissions/${tk.data.id}/file`, { method: 'PUT', body: pdf, token: author, contentType: 'application/pdf' })).response.status, 200);
  assert.equal((await api(env, `/api/me/submissions/${tk.data.id}/file`, { token: curator })).response.status, 404);
  assert.equal((await api(env, `/api/submissions/${tk.data.id}/file`)).response.status, 404);
  assert.equal((await api(env, `/api/submissions/${tk.data.id}/provenance`)).response.status, 404);
  assert.equal((await api(env, `/api/submissions/${tk.data.id}/provenance`, { token: curator })).response.status, 404);
  assert.equal((await api(env, `/api/submissions/${tk.data.id}/provenance`, { token: author })).data.versions.length, 1);
  assert.equal((await api(env, `/api/submissions/${tk.data.id}/jsonld`)).response.status, 404);
  env.sqlite.close();
});

test('metadata revisions and file digests are owner-only until publication and never claim legal priority', async () => {
  const env = environment();
  const author = (await api(env, '/api/auth/register', { method: 'POST', body: credentials })).data.token;
  const curator = (await api(env, '/api/auth/bootstrap', { method: 'POST', body: { email: 'curator@example.org', password: credentials.password, setupToken: env.CURATOR_SETUP_TOKEN } })).data.token;
  const { data: { id } } = await api(env, '/api/submissions', { method: 'POST', token: author, body: metadata });
  assert.equal((await api(env, `/api/submissions/${id}/provenance`)).response.status, 404);
  assert.equal((await api(env, `/api/submissions/${id}/provenance`, { token: curator })).response.status, 404);
  const translations = [{ language: 'en', title: 'Revision', abstract: 'Updated' }];
  assert.equal((await api(env, `/api/me/submissions/${id}/versions`, { method: 'POST', token: author, body: { translations } })).data.version, 2);
  assert.equal((await api(env, `/api/me/submissions/${id}/versions`, { method: 'POST', token: curator, body: { translations } })).response.status, 404);
  const pdf = new TextEncoder().encode('%PDF-1.4\n%%EOF');
  await api(env, `/api/me/submissions/${id}/file`, { method: 'PUT', token: author, contentType: 'application/pdf', body: pdf });
  const own = (await api(env, `/api/submissions/${id}/provenance`, { token: author })).data;
  assert.equal(own.legalPriorArtDetermination, false);
  assert.equal(own.evidenceType, 'local_sha256_and_server_clock_only');
  assert.equal(own.versions.length, 2);
  assert.match(own.fileSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(own.versions[0].metadataSha256, own.versions[1].metadataSha256);
  assert.equal(own.versions[0].translations[0].title, 'A study');
  assert.equal(own.versions[1].translations[0].title, 'Revision');
  await api(env, `/api/curation/submissions/${id}/approve`, { method: 'POST', token: curator, body: {} });
  assert.equal((await api(env, `/api/me/submissions/${id}/versions`, { method: 'POST', token: author, body: { translations } })).response.status, 409);
  assert.throws(() => env.sqlite.prepare('UPDATE submission_metadata SET title = ? WHERE submission_id = ?').run('tampered', id), /immutable/);
  const linked = await api(env, `/api/submissions/${id}/jsonld`);
  assert.equal(linked.response.headers.get('content-type'), 'application/ld+json; charset=utf-8');
  assert.equal(linked.data.name, 'Revision');
  assert.equal(linked.data['@type'], 'ScholarlyArticle');
  assert.equal((await api(env, `/api/submissions/${id}/provenance`)).data.versions.length, 2);
  env.sqlite.close();
});

test('configured open JSON feed imports bounded, deduplicated private metadata for independent review', async () => {
  const env = environment();
  const author = (await api(env, '/api/auth/register', { method: 'POST', body: credentials })).data.token;
  const curator = (await api(env, '/api/auth/bootstrap', { method: 'POST', body: { email: 'curator@example.org', password: credentials.password, setupToken: env.CURATOR_SETUP_TOKEN } })).data.token;
  const endpoint = '/api/curation/ingest';
  assert.equal((await api(env, endpoint, { method: 'POST', token: author })).response.status, 403);
  assert.equal((await api(env, endpoint, { method: 'POST', token: curator })).response.status, 503);
  env.INGEST_SOURCE_URL = 'https://repository.example.org/open.json';
  env.INGEST_SOURCE_LICENSE = 'https://creativecommons.org/licenses/by/4.0/';
  const record = { sourceId: 'oai:repository.example.org:1', sourceUrl: 'https://repository.example.org/1', kind: 'dataset', language: 'yo', title: 'Open & shared', abstract: 'Findings <clear>', license: env.INGEST_SOURCE_LICENSE };
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json([record]);
    const first = await api(env, endpoint, { method: 'POST', token: curator });
    assert.equal(first.response.status, 200);
    assert.equal(first.data.created.length, 1);
    const id = first.data.created[0];
    assert.equal((await api(env, '/api/submissions')).data.items.length, 0);
    assert.equal((await api(env, `/api/submissions/${id}/provenance`)).response.status, 404);
    assert.equal((await api(env, endpoint, { method: 'POST', token: curator })).data.duplicates, 1);
    assert.equal((await api(env, '/api/curation/submissions', { token: curator })).data.items.length, 1);
    await api(env, `/api/curation/submissions/${id}/approve`, { method: 'POST', token: curator, body: {} });
    assert.equal((await api(env, `/api/submissions/${id}/jsonld`)).data.license, record.license);
    const evidence = (await api(env, `/api/submissions/${id}/provenance`)).data;
    assert.equal(evidence.sourceIdentifier, record.sourceId);
    assert.equal(evidence.fileSha256, null);
    globalThis.fetch = async () => Response.json([{ ...record, sourceUrl: 'https://127.0.0.1/private' }]);
    assert.equal((await api(env, endpoint, { method: 'POST', token: curator })).response.status, 400);
    globalThis.fetch = async () => Response.json(Array(21).fill(record));
    assert.equal((await api(env, endpoint, { method: 'POST', token: curator })).response.status, 400);
  } finally {
    globalThis.fetch = original;
    env.sqlite.close();
  }
});

test('OAI-PMH emits only approved public Dublin Core XML and paginates bounded results', async () => {
  const env = environment();
  const author = (await api(env, '/api/auth/register', { method: 'POST', body: credentials })).data.token;
  const curator = (await api(env, '/api/auth/bootstrap', { method: 'POST', body: { email: 'curator@example.org', password: credentials.password, setupToken: env.CURATOR_SETUP_TOKEN } })).data.token;
  const privateItem = await api(env, '/api/submissions', { method: 'POST', token: author, body: metadata });
  const tk = await api(env, '/api/submissions', { method: 'POST', token: author, body: { ...metadata, kind: 'traditional_knowledge', consentAcknowledged: true } });
  const adminEmail = env.OAI_ADMIN_EMAIL;
  delete env.OAI_ADMIN_EMAIL;
  assert.equal((await api(env, '/oai?verb=Identify')).response.status, 503);
  env.OAI_ADMIN_EMAIL = adminEmail;
  assert.match(await (await api(env, '/oai?verb=ListRecords&metadataPrefix=oai_dc')).response.text(), /noRecordsMatch/);
  const ids = [];
  for (let i = 0; i < 21; i++) {
    const { data: { id } } = await api(env, '/api/submissions', { method: 'POST', token: author, body: { ...metadata, translations: [{ language: 'en', title: `Paper ${i} & more`, abstract: '<safe>' }] } });
    ids.push(id);
    await api(env, `/api/curation/submissions/${id}/approve`, { method: 'POST', token: curator, body: {} });
  }
  const first = await (await api(env, '/oai?verb=ListRecords&metadataPrefix=oai_dc')).response.text();
  assert.equal((first.match(/<record>/g) || []).length, 20);
  const token = first.match(/<resumptionToken>([^<]+)<\/resumptionToken>/)?.[1];
  assert.ok(token);
  assert.match(first, /&amp; more/);
  assert.match(first, /&lt;safe&gt;/);
  assert.doesNotMatch(first, new RegExp(privateItem.data.id));
  assert.doesNotMatch(first, new RegExp(tk.data.id));
  const second = await (await api(env, `/oai?verb=ListRecords&resumptionToken=${token}`)).response.text();
  assert.equal((second.match(/<record>/g) || []).length, 1);
  const identifier = `oai:example.invalid:${ids[0]}`;
  assert.match(await (await api(env, `/oai?verb=GetRecord&metadataPrefix=oai_dc&identifier=${identifier}`)).response.text(), /<GetRecord>/);
  assert.match(await (await api(env, `/oai?verb=GetRecord&metadataPrefix=oai_dc&identifier=oai:example.invalid:${tk.data.id}`)).response.text(), /idDoesNotExist/);
  assert.match(await (await api(env, '/oai?verb=ListIdentifiers&metadataPrefix=oai_dc')).response.text(), /<header>/);
  assert.match(await (await api(env, '/oai?verb=Identify')).response.text(), /<protocolVersion>2.0<\/protocolVersion>/);
  assert.match(await (await api(env, '/oai?verb=ListMetadataFormats')).response.text(), /oai_dc/);
  assert.match(await (await api(env, '/oai?verb=ListRecords&resumptionToken=../../')).response.text(), /badResumptionToken/);
  env.sqlite.close();
});
