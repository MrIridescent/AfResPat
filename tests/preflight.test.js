import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { prepareDeployment, validateDeployment } from '../src/preflight.js';

const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const account = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) };

function provisionedConfig() {
  return {
    ...config,
    d1_databases: [{ ...config.d1_databases[0], database_id: 'b'.repeat(32) }],
    kv_namespaces: [{ ...config.kv_namespaces[0], id: 'c'.repeat(32) }],
    vars: { OAI_ADMIN_EMAIL: 'contact@example.org' }
  };
}

test('unprovisioned configuration blocks deployment with actionable binding errors', () => {
  const errors = validateDeployment(config, {});
  assert.match(errors.join(' '), /CLOUDFLARE_ACCOUNT_ID/);
  assert.match(errors.join(' '), /database_id/);
  assert.match(errors.join(' '), /kv_namespaces/);
  assert.equal(config.vars.OAI_ADMIN_EMAIL, 'david.oke@i2sltd.tech');
  assert.doesNotMatch(errors.join(' '), /OAI_ADMIN_EMAIL/);
});

test('provisioned bindings and contact pass local preflight', () => {
  assert.deepEqual(validateDeployment(provisionedConfig(), account), []);
});

test('release configuration uses supplied resource IDs without publishing credentials', () => {
  const environment = { ...account, D1_DATABASE_ID: 'b'.repeat(32), KV_NAMESPACE_ID: 'c'.repeat(32), CURATOR_SETUP_TOKEN: 'private-value' };
  const prepared = prepareDeployment(config, environment);
  assert.deepEqual(validateDeployment(prepared, environment), []);
  assert.equal(prepared.d1_databases[0].database_id, environment.D1_DATABASE_ID);
  assert.equal(prepared.kv_namespaces[0].id, environment.KV_NAMESPACE_ID);
  assert.doesNotMatch(JSON.stringify(prepared), /private-value/);
  assert.equal(config.d1_databases[0].database_id, undefined);
  assert.equal(config.kv_namespaces[0].id, undefined);
});

test('configuration cannot publish the curator bootstrap secret as a plaintext var', () => {
  const invalid = provisionedConfig();
  invalid.vars.CURATOR_SETUP_TOKEN = 'secret';
  assert.match(validateDeployment(invalid, account).join(' '), /Never store CURATOR_SETUP_TOKEN/);
});

test('placeholder IDs and broken API routing cannot pass preflight', () => {
  const invalid = provisionedConfig();
  invalid.kv_namespaces[0].id = 'replace-me';
  invalid.assets.run_worker_first = [];
  assert.match(validateDeployment(invalid, account).join(' '), /kv_namespaces/);
  assert.match(validateDeployment(invalid, account).join(' '), /API-first/);
});
