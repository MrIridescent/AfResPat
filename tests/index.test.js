import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

const records = [
  { id: 'paper-1', kind: 'research', visibility: 'public', reviewStatus: 'approved', primaryLanguage: 'yo', title: 'Iwadi', createdAt: '2026-01-01' },
  { id: 'paper-2', kind: 'research', visibility: 'private', reviewStatus: 'pending', primaryLanguage: 'en', title: 'Private', createdAt: '2026-01-02' },
  { id: 'tk-1', kind: 'traditional_knowledge', visibility: 'public', reviewStatus: 'approved', primaryLanguage: 'en', title: 'Protected', createdAt: '2026-01-03' },
  { id: 'unapproved-1', kind: 'research', visibility: 'public', reviewStatus: 'pending', primaryLanguage: 'en', title: 'Unreviewed', createdAt: '2026-01-04' }
];

function database() {
  return {
    prepare(sql) {
      const translations = sql.includes('FROM submission_metadata');
      if (!translations) assert.match(sql, /s\.visibility = 'public' AND s\.review_status = 'approved' AND s\.kind <> 'traditional_knowledge'/);
      return {
        bind(...values) {
          return {
            async first() {
              const record = records.find(item => item.id === values[0] && item.visibility === 'public' && item.reviewStatus === 'approved' && item.kind !== 'traditional_knowledge');
              if (!record) return null;
              const { title, visibility, ...metadata } = record;
              return { ...metadata, sourceUrl: null };
            },
            async all() {
              if (translations) return { results: [
                { language: 'en', title: 'Study', abstract: 'Summary' },
                { language: 'yo', title: 'Iwadi', abstract: 'Akopo' }
              ] };
              const visible = records.filter(item => item.visibility === 'public' && item.reviewStatus === 'approved' && item.kind !== 'traditional_knowledge');
              return { results: visible.slice(values[1], values[1] + values[0]).map(({ visibility, ...item }) => item) };
            }
          };
        }
      };
    }
  };
}

async function fetch(path, env = { DB: database() }, method = 'GET') {
  return worker.fetch(new Request(`https://example.invalid${path}`, { method }), env);
}

test('health does not imply storage readiness; missing DB returns 503', async () => {
  assert.deepEqual(await (await fetch('/api/health', {})).json(), { status: 'running' });
  const response = await fetch('/api/submissions', {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'database_unavailable' });
});

test('only public non-traditional metadata is listed, with bounded pagination', async () => {
  const response = await fetch('/api/submissions?limit=1&offset=0');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await response.json()).items.map(item => item.id), ['paper-1']);
  for (const path of ['/api/submissions?limit=51', '/api/submissions?limit=0', '/api/submissions?offset=-1']) {
    assert.equal((await fetch(path)).status, 400);
  }
});

test('detail serves multilingual metadata but not private or traditional knowledge records', async () => {
  const publicRecord = await (await fetch('/api/submissions/paper-1')).json();
  assert.deepEqual(publicRecord.translations.map(item => item.language), ['en', 'yo']);
  assert.equal(publicRecord.primaryLanguage, 'yo');
  assert.equal((await fetch('/api/submissions/paper-2')).status, 404);
  assert.equal((await fetch('/api/submissions/tk-1')).status, 404);
  assert.equal((await fetch('/api/submissions/%E0%A4%A')).status, 404);
});

test('methods and database failures are handled without leaking details', async () => {
  assert.equal((await fetch('/api/submissions', undefined, 'DELETE')).status, 405);
  assert.equal((await fetch('/unknown')).status, 404);
  const broken = { DB: { prepare() { throw new Error('secret connection detail'); } } };
  const response = await fetch('/api/submissions', broken);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /secret connection detail/);
});
