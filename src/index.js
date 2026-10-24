import { linkedData, oai } from './interoperability.js';

const encoder = new TextEncoder();
const publicFilter = "s.visibility = 'public' AND s.review_status = 'approved' AND s.kind <> 'traditional_knowledge'";
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const languagePattern = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers
    }
  });
}

function pageNumber(value, fallback, maximum) {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= maximum ? number : null;
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function digest(value) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

function safeHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.hash && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.hostname.endsWith('.localhost') && !url.hostname.endsWith('.internal') && !/^10\.|^127\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname);
  } catch { return false; }
}

async function ingest(request, env, db, user) {
  if (user.role !== 'curator') return json({ error: 'forbidden' }, 403);
  const feed = env.INGEST_SOURCE_URL;
  if (typeof feed !== 'string' || !safeHttps(feed) || !env.INGEST_SOURCE_LICENSE || !['https://creativecommons.org/licenses/by/4.0/', 'https://creativecommons.org/licenses/by-sa/4.0/', 'https://creativecommons.org/publicdomain/zero/1.0/'].includes(env.INGEST_SOURCE_LICENSE)) return json({ error: 'ingest_unconfigured' }, 503);
  let fetched;
  let bytes;
  try {
    fetched = await fetch(feed, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!fetched.ok || fetched.redirected || fetched.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'source_unavailable' }, 502);
    bytes = await boundedBody(fetched, 131072);
  } catch { return json({ error: 'source_unavailable' }, 502); }
  if (!bytes) return json({ error: 'source_unavailable' }, 502);
  let records;
  try { records = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return json({ error: 'source_unavailable' }, 502); }
  if (!Array.isArray(records) || records.length > 20) return json({ error: 'invalid_feed' }, 400);
  for (const record of records) {
    if (!record || typeof record.sourceId !== 'string' || record.sourceId.length < 1 || record.sourceId.length > 256 || !safeHttps(record.sourceUrl) || !['research', 'dataset'].includes(record.kind) || record.license !== env.INGEST_SOURCE_LICENSE || !validSubmission({ kind: record.kind, primaryLanguage: record.language, translations: [{ language: record.language, title: record.title, abstract: record.abstract }], sourceUrl: record.sourceUrl })) return json({ error: 'invalid_feed' }, 400);
  }
  const sourceUser = `feed-${await digest(feed)}`;
  await db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').bind(sourceUser).run();
  const created = [];
  let duplicates = 0;
  for (const record of records) {
    const id = crypto.randomUUID();
    const translations = [{ language: record.language, title: record.title.trim(), abstract: record.abstract }];
    const metadata = JSON.stringify(translations);
    const hash = await digest(metadata);
    try {
      await db.batch([
        db.prepare('INSERT INTO submissions (id, author_id, kind, primary_language, source_url, source_feed, source_identifier, source_license) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, sourceUser, record.kind, record.language, record.sourceUrl, feed, record.sourceId, record.license),
        db.prepare('INSERT INTO submission_metadata (submission_id, language, title, abstract) VALUES (?, ?, ?, ?)').bind(id, record.language, record.title.trim(), record.abstract),
        db.prepare('INSERT INTO submission_versions (submission_id, version, metadata_sha256, metadata_json, recorded_at) VALUES (?, 1, ?, ?, ?)').bind(id, hash, metadata, new Date().toISOString())
      ]);
      created.push(id);
    } catch (error) {
      if (!String(error).includes('UNIQUE')) throw error;
      duplicates++;
    }
  }
  return json({ created, duplicates, reviewStatus: 'pending' });
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return bytesToHex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: Uint8Array.from(salt.match(/../g), part => parseInt(part, 16)), iterations: 310000, hash: 'SHA-256' }, key, 256)));
}

function equalHex(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

async function boundedBody(request, maximum) {
  if (request.headers.has('content-length') && Number(request.headers.get('content-length')) > maximum) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function input(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') || '')) return null;
  const bytes = await boundedBody(request, 16384);
  if (!bytes) return null;
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function validAccount(body) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = body?.password;
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,30}$/.test(email) && email.length <= 254 && typeof password === 'string' && password.length >= 12 && password.length <= 128 ? { email, password } : null;
}

function validSubmission(body) {
  if (!body || !['research', 'dataset', 'traditional_knowledge'].includes(body.kind) || !languagePattern.test(body.primaryLanguage || '')) return null;
  if (!Array.isArray(body.translations) || body.translations.length < 1 || body.translations.length > 10) return null;
  const seen = new Set();
  for (const item of body.translations) {
    if (!item || typeof item.language !== 'string' || !languagePattern.test(item.language) || seen.has(item.language.toLowerCase()) || typeof item.title !== 'string' || item.title.trim().length < 1 || item.title.length > 240 || typeof item.abstract !== 'string' || item.abstract.length > 10000) return null;
    seen.add(item.language.toLowerCase());
  }
  if (!seen.has(body.primaryLanguage.toLowerCase())) return null;
  if (body.sourceUrl !== undefined && body.sourceUrl !== null) {
    if (typeof body.sourceUrl !== 'string' || body.sourceUrl.length > 2048) return null;
    try {
      const source = new URL(body.sourceUrl);
      if (source.protocol !== 'https:' || !source.hostname || source.username || source.password) return null;
    } catch { return null; }
  }
  if (body.kind === 'traditional_knowledge' && body.consentAcknowledged !== true) return null;
  return body;
}

async function identity(request, db) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') || '');
  if (!match) return null;
  return db.prepare(`SELECT u.id, c.email, c.role FROM sessions s
    JOIN users u ON u.id = s.user_id JOIN local_credentials c ON c.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await digest(match[1]), new Date().toISOString()).first();
}

async function createSession(db, user) {
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const expiry = new Date(Date.now() + 7 * 86400000).toISOString();
  await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await digest(token), user.id, expiry).run();
  return json({ token, expiresAt: expiry, user: { id: user.id, email: user.email, role: user.role } });
}

async function register(request, env, bootstrap) {
  const body = await input(request);
  const account = validAccount(body);
  if (!account) return json({ error: 'invalid_account' }, 400);
  if (bootstrap) {
    if (typeof env.CURATOR_SETUP_TOKEN !== 'string' || env.CURATOR_SETUP_TOKEN.length < 32 || typeof body.setupToken !== 'string' || !equalHex(await digest(body.setupToken), await digest(env.CURATOR_SETUP_TOKEN))) return json({ error: 'forbidden' }, 403);
  }
  const db = env.DB;
  if (await db.prepare('SELECT user_id FROM local_credentials WHERE email = ?').bind(account.email).first()) return json({ error: 'account_exists' }, 409);
  if (bootstrap && await db.prepare("SELECT user_id FROM local_credentials WHERE role = 'curator' LIMIT 1").bind().first()) return json({ error: 'bootstrap_closed' }, 403);
  const id = crypto.randomUUID();
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await passwordHash(account.password, salt);
  try {
    const credential = bootstrap
      ? db.prepare(`INSERT INTO local_credentials (user_id, email, password_salt, password_hash, role)
        SELECT ?, ?, ?, ?, 'curator' WHERE NOT EXISTS (SELECT 1 FROM local_credentials WHERE role = 'curator')`).bind(id, account.email, salt, hash)
      : db.prepare('INSERT INTO local_credentials (user_id, email, password_salt, password_hash) VALUES (?, ?, ?, ?)').bind(id, account.email, salt, hash);
    const results = await db.batch([db.prepare('INSERT INTO users (id) VALUES (?)').bind(id), credential]);
    if (bootstrap && results[1].meta?.changes !== 1) return json({ error: 'bootstrap_closed' }, 403);
  } catch (error) {
    if (String(error).includes('UNIQUE')) return json({ error: 'account_exists' }, 409);
    throw error;
  }
  return createSession(db, { id, email: account.email, role: bootstrap ? 'curator' : 'author' });
}

async function login(request, db) {
  const account = validAccount(await input(request));
  if (!account) return json({ error: 'invalid_account' }, 400);
  const now = new Date().toISOString();
  const windowStart = new Date(Date.now() - 15 * 60000).toISOString();
  const attempt = await db.prepare('SELECT failures, first_attempt_at FROM login_attempts WHERE email = ?').bind(account.email).first();
  if (attempt && attempt.first_attempt_at > windowStart && attempt.failures >= 5) return json({ error: 'rate_limited' }, 429);
  const user = await db.prepare(`SELECT u.id, c.email, c.role, c.password_salt AS salt, c.password_hash AS hash
    FROM local_credentials c JOIN users u ON u.id = c.user_id WHERE c.email = ?`).bind(account.email).first();
  const computed = await passwordHash(account.password, user?.salt || '00000000000000000000000000000000');
  if (!user || !equalHex(computed, user.hash)) {
    await db.prepare(`INSERT INTO login_attempts (email, failures, first_attempt_at) VALUES (?, 1, ?)
      ON CONFLICT(email) DO UPDATE SET failures = CASE WHEN first_attempt_at <= ? THEN 1 ELSE failures + 1 END,
      first_attempt_at = CASE WHEN first_attempt_at <= ? THEN excluded.first_attempt_at ELSE first_attempt_at END`).bind(account.email, now, windowStart, windowStart).run();
    return json({ error: 'invalid_credentials' }, 401);
  }
  await db.prepare('DELETE FROM login_attempts WHERE email = ?').bind(account.email).run();
  return createSession(db, user);
}

async function createSubmission(request, db, user) {
  const body = validSubmission(await input(request));
  if (!body) return json({ error: 'invalid_submission' }, 400);
  const id = crypto.randomUUID();
  const statements = [db.prepare(`INSERT INTO submissions (id, author_id, kind, primary_language, source_url)
    VALUES (?, ?, ?, ?, ?)`).bind(id, user.id, body.kind, body.primaryLanguage, body.sourceUrl || null)];
  for (const translation of body.translations) {
    statements.push(db.prepare('INSERT INTO submission_metadata (submission_id, language, title, abstract) VALUES (?, ?, ?, ?)').bind(id, translation.language, translation.title.trim(), translation.abstract));
  }
  const translations = body.translations.map(item => ({ language: item.language, title: item.title.trim(), abstract: item.abstract }));
  const metadata = JSON.stringify(translations.sort((a, b) => a.language.localeCompare(b.language)));
  statements.push(db.prepare('INSERT INTO submission_versions (submission_id, version, metadata_sha256, metadata_json, recorded_at) VALUES (?, 1, ?, ?, ?)').bind(id, await digest(metadata), metadata, new Date().toISOString()));
  await db.batch(statements);
  return json({ id, visibility: 'private', reviewStatus: 'pending', consentStatus: 'pending' }, 201);
}

async function upload(request, env, db, user, id) {
  if (!env.R2_BUCKET?.put) return json({ error: 'storage_unavailable' }, 503);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/pdf') return json({ error: 'invalid_file' }, 400);
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length < 5 || length > 10 * 1024 * 1024) return json({ error: 'invalid_file' }, 400);
  const submission = await db.prepare('SELECT author_id, review_status, file_key FROM submissions WHERE id = ?').bind(id).first();
  if (!submission || submission.author_id !== user.id) return json({ error: 'not_found' }, 404);
  if (submission.review_status !== 'pending' || submission.file_key) return json({ error: 'conflict' }, 409);
  const data = await boundedBody(request, 10 * 1024 * 1024);
  if (!data || data.byteLength !== length || String.fromCharCode(...data.slice(0, 5)) !== '%PDF-') return json({ error: 'invalid_file' }, 400);
  const key = `private/${id}/${crypto.randomUUID()}.pdf`;
  const fileHash = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
  await env.R2_BUCKET.put(key, data, { httpMetadata: { contentType: 'application/pdf' } });
  try {
    const result = await db.prepare("UPDATE submissions SET file_key = ?, file_sha256 = ? WHERE id = ? AND author_id = ? AND review_status = 'pending' AND file_key IS NULL").bind(key, fileHash, id, user.id).run();
    if (result.meta?.changes !== 1) {
      await env.R2_BUCKET.delete(key);
      return json({ error: 'conflict' }, 409);
    }
  } catch (error) {
    await env.R2_BUCKET.delete(key);
    throw error;
  }
  return json({ uploaded: true });
}

async function download(env, db, id, user) {
  const submission = await db.prepare('SELECT author_id, kind, visibility, review_status, file_key FROM submissions WHERE id = ?').bind(id).first();
  if (!submission?.file_key || !(user?.id === submission.author_id || (user?.role === 'curator' && submission.kind !== 'traditional_knowledge') || (submission.visibility === 'public' && submission.review_status === 'approved' && submission.kind !== 'traditional_knowledge'))) return json({ error: 'not_found' }, 404);
  if (!env.R2_BUCKET?.get) return json({ error: 'storage_unavailable' }, 503);
  const file = await env.R2_BUCKET.get(submission.file_key);
  if (!file) return json({ error: 'not_found' }, 404);
  return new Response(file.body, { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="research.pdf"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

async function revise(request, db, user, id) {
  const existing = await db.prepare('SELECT kind, primary_language AS primaryLanguage, review_status AS reviewStatus, source_url AS sourceUrl, source_feed AS sourceFeed FROM submissions WHERE id = ? AND author_id = ?').bind(id, user.id).first();
  if (!existing) return json({ error: 'not_found' }, 404);
  if (existing.reviewStatus !== 'pending' || existing.sourceFeed) return json({ error: 'conflict' }, 409);
  const body = await input(request);
  const submission = validSubmission({ kind: existing.kind, primaryLanguage: existing.primaryLanguage, sourceUrl: existing.sourceUrl, consentAcknowledged: existing.kind === 'traditional_knowledge', translations: body?.translations });
  if (!submission || Object.keys(body).some(key => key !== 'translations')) return json({ error: 'invalid_submission' }, 400);
  const translations = body.translations.map(({ language, title, abstract }) => ({ language, title: title.trim(), abstract })).sort((a, b) => a.language.localeCompare(b.language));
  const metadata = JSON.stringify(translations);
  const version = (await db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM submission_versions WHERE submission_id = ?').bind(id).first()).next;
  await db.batch([
    db.prepare('DELETE FROM submission_metadata WHERE submission_id = ?').bind(id),
    ...translations.map(item => db.prepare('INSERT INTO submission_metadata (submission_id, language, title, abstract) VALUES (?, ?, ?, ?)').bind(id, item.language, item.title, item.abstract)),
    db.prepare('INSERT INTO submission_versions (submission_id, version, metadata_sha256, metadata_json, recorded_at) VALUES (?, ?, ?, ?, ?)').bind(id, version, await digest(metadata), metadata, new Date().toISOString())
  ]);
  return json({ id, version, reviewStatus: 'pending' });
}

async function provenance(db, id, user) {
  const item = await db.prepare('SELECT s.id, s.author_id AS authorId, s.kind, s.visibility, s.review_status AS reviewStatus, s.file_sha256 AS fileSha256, s.source_url AS sourceUrl, s.source_feed AS sourceFeed, s.source_identifier AS sourceIdentifier, s.source_license AS sourceLicense, s.reviewed_at AS reviewedAt FROM submissions s WHERE s.id = ?').bind(id).first();
  if (!item || (user?.id !== item.authorId && !(item.visibility === 'public' && item.reviewStatus === 'approved' && item.kind !== 'traditional_knowledge'))) return json({ error: 'not_found' }, 404);
  const rows = (await db.prepare('SELECT version, metadata_sha256 AS metadataSha256, metadata_json AS metadataJson, recorded_at AS recordedAt FROM submission_versions WHERE submission_id = ? ORDER BY version').bind(id).all()).results;
  const versions = rows.map(({ metadataJson, ...version }) => ({ ...version, translations: JSON.parse(metadataJson) }));
  return json({ id, evidenceType: 'local_sha256_and_server_clock_only', legalPriorArtDetermination: false, sourceUrl: item.sourceUrl, sourceFeed: item.sourceFeed, sourceIdentifier: item.sourceIdentifier, sourceLicense: item.sourceLicense, fileSha256: item.fileSha256, reviewedAt: item.reviewedAt, versions });
}

async function review(request, db, user, id, decision) {
  if (user.role !== 'curator') return json({ error: 'forbidden' }, 403);
  const body = await input(request);
  if (!body) return json({ error: 'invalid_review' }, 400);
  const result = await db.prepare(`UPDATE submissions SET review_status = ?, visibility = ?, reviewed_by = ?, reviewed_at = ?
    WHERE id = ? AND review_status = 'pending' AND kind <> 'traditional_knowledge' AND author_id <> ?`).bind(decision, decision === 'approved' ? 'public' : 'private', user.id, new Date().toISOString(), id, user.id).run();
  if (result.meta?.changes !== 1) return json({ error: 'not_found_or_not_pending' }, 404);
  return json({ id, reviewStatus: decision, visibility: decision === 'approved' ? 'public' : 'private' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const detail = /^\/api\/submissions\/([^/]+)$/.exec(url.pathname);
    const publicFile = /^\/api\/submissions\/([^/]+)\/file$/.exec(url.pathname);
    const privateFile = /^\/api\/me\/submissions\/([^/]+)\/file$/.exec(url.pathname);
    const decision = /^\/api\/curation\/submissions\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
    const curationDetail = /^\/api\/curation\/submissions\/([^/]+)$/.exec(url.pathname);
    const revision = /^\/api\/me\/submissions\/([^/]+)\/versions$/.exec(url.pathname);
    const evidence = /^\/api\/submissions\/([^/]+)\/provenance$/.exec(url.pathname);
    const linked = /^\/api\/submissions\/([^/]+)\/jsonld$/.exec(url.pathname);
    const path = url.pathname;
    if (path === '/api/health') return request.method === 'GET' ? json({ status: 'running' }) : json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
    if (!['/api/submissions', '/api/me/submissions', '/api/curation/submissions', '/api/curation/ingest', '/api/auth/register', '/api/auth/bootstrap', '/api/auth/login', '/api/auth/logout', '/api/auth/me', '/oai'].includes(path) && !detail && !publicFile && !privateFile && !decision && !curationDetail && !revision && !evidence && !linked) return json({ error: 'not_found' }, 404);
    const allowed = path === '/api/submissions' ? 'GET, POST' : path === '/oai' || path === '/api/me/submissions' || path === '/api/curation/submissions' || path === '/api/auth/me' || detail || publicFile || curationDetail || evidence || linked ? 'GET' : privateFile ? 'GET, PUT' : 'POST';
    if (!allowed.split(', ').includes(request.method)) return json({ error: 'method_not_allowed' }, 405, { allow: allowed });
    if ((detail || publicFile || privateFile || decision || curationDetail || revision || evidence || linked) && !idPattern.test((detail || publicFile || privateFile || decision || curationDetail || revision || evidence || linked)[1])) return json({ error: 'not_found' }, 404);
    if (!env?.DB || typeof env.DB.prepare !== 'function') return json({ error: 'database_unavailable' }, 503);
    const db = env.DB;
    try {
      if (path === '/api/auth/register' || path === '/api/auth/bootstrap') return register(request, env, path.endsWith('bootstrap'));
      if (path === '/api/auth/login') return login(request, db);
      if (path === '/oai') return typeof env.OAI_ADMIN_EMAIL === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.OAI_ADMIN_EMAIL) ? oai(request, db, env.OAI_ADMIN_EMAIL) : json({ error: 'oai_unconfigured' }, 503);
      const needsAuth = path === '/api/auth/me' || path === '/api/auth/logout' || path === '/api/me/submissions' || path === '/api/curation/submissions' || path === '/api/curation/ingest' || decision || curationDetail || revision || privateFile || (path === '/api/submissions' && request.method === 'POST');
      const user = needsAuth || publicFile || evidence ? await identity(request, db) : null;
      if (needsAuth && !user) return json({ error: 'unauthorized' }, 401);
      if (path === '/api/auth/me') return json({ user });
      if (path === '/api/auth/logout') {
        const token = request.headers.get('authorization').slice(7);
        await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await digest(token)).run();
        return json({ loggedOut: true });
      }
      if (path === '/api/submissions' && request.method === 'POST') return createSubmission(request, db, user);
      if (path === '/api/curation/ingest') return ingest(request, env, db, user);
      if (revision) return revise(request, db, user, revision[1]);
      if (evidence) return provenance(db, evidence[1], user);
      if (privateFile) return request.method === 'PUT' ? upload(request, env, db, user, privateFile[1]) : download(env, db, privateFile[1], user);
      if (publicFile) return download(env, db, publicFile[1], user);
      if (decision) return review(request, db, user, decision[1], decision[2] === 'approve' ? 'approved' : 'rejected');
      if (curationDetail) {
        if (user.role !== 'curator') return json({ error: 'forbidden' }, 403);
        const submission = await db.prepare(`SELECT id, kind, primary_language AS primaryLanguage, source_url AS sourceUrl,
          file_key IS NOT NULL AS hasFile FROM submissions WHERE id = ? AND review_status = 'pending'
          AND kind <> 'traditional_knowledge' AND author_id <> ?`).bind(curationDetail[1], user.id).first();
        if (!submission) return json({ error: 'not_found' }, 404);
        const translations = await db.prepare('SELECT language, title, abstract FROM submission_metadata WHERE submission_id = ? ORDER BY language').bind(submission.id).all();
        return json({ ...submission, translations: translations.results });
      }
      if (path === '/api/me/submissions' || path === '/api/curation/submissions') {
        if (path === '/api/curation/submissions' && user.role !== 'curator') return json({ error: 'forbidden' }, 403);
        const limit = pageNumber(url.searchParams.get('limit'), 20, 50);
        const offset = pageNumber(url.searchParams.get('offset'), 0, 1000);
        if (!limit || offset === null) return json({ error: 'invalid_pagination' }, 400);
        const filter = path === '/api/me/submissions' ? 's.author_id = ?' : "s.review_status = 'pending' AND s.kind <> 'traditional_knowledge' AND s.author_id <> ?";
        const query = `SELECT s.id, s.kind, s.visibility, s.review_status AS reviewStatus, s.primary_language AS primaryLanguage,
          s.created_at AS createdAt, s.file_key IS NOT NULL AS hasFile, m.title FROM submissions s
          JOIN submission_metadata m ON m.submission_id = s.id AND m.language = s.primary_language
          WHERE ${filter} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`;
        const values = [user.id, limit, offset];
        const result = await db.prepare(query).bind(...values).all();
        return json({ items: result.results, limit, offset });
      }
      if (detail || linked) {
        const submission = await db.prepare(`SELECT s.id, s.kind, s.primary_language AS primaryLanguage, s.source_url AS sourceUrl,
          s.created_at AS createdAt, s.reviewed_at AS reviewedAt, s.source_feed AS sourceFeed, s.source_license AS sourceLicense,
          s.file_key IS NOT NULL AS hasFile FROM submissions s
          WHERE s.id = ? AND ${publicFilter}`).bind((detail || linked)[1]).first();
        if (!submission) return json({ error: 'not_found' }, 404);
        const translations = await db.prepare('SELECT language, title, abstract FROM submission_metadata WHERE submission_id = ? ORDER BY language').bind(submission.id).all();
        if (linked) return json(linkedData({ ...submission, translations: translations.results }, url.origin), 200, { 'content-type': 'application/ld+json; charset=utf-8' });
        return json({ ...submission, translations: translations.results });
      }
      const limit = pageNumber(url.searchParams.get('limit'), 20, 50);
      const offset = pageNumber(url.searchParams.get('offset'), 0, 1000);
      if (!limit || offset === null) return json({ error: 'invalid_pagination' }, 400);
      const result = await db.prepare(`SELECT s.id, s.kind, s.primary_language AS primaryLanguage,
        m.title, s.created_at AS createdAt FROM submissions s
        JOIN submission_metadata m ON m.submission_id = s.id AND m.language = s.primary_language
        WHERE ${publicFilter} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`).bind(limit, offset).all();
      return json({ items: result.results, limit, offset });
    } catch {
      return json({ error: 'database_unavailable' }, 503);
    }
  }
};
