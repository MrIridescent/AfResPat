import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const resourceId = /^[a-f0-9]{32}$/i;

export function prepareDeployment(config, environment) {
  return {
    ...config,
    d1_databases: config.d1_databases?.map(database => ({ ...database, database_id: environment.D1_DATABASE_ID || database.database_id })),
    kv_namespaces: config.kv_namespaces?.map(namespace => ({ ...namespace, id: environment.KV_NAMESPACE_ID || namespace.id }))
  };
}

export function validateDeployment(config, environment) {
  const errors = [];
  if (!resourceId.test(environment.CLOUDFLARE_ACCOUNT_ID || '')) errors.push('Set CLOUDFLARE_ACCOUNT_ID to the provisioned Cloudflare account ID in the deploy environment.');
  if (!config || typeof config !== 'object') return [...errors, 'Provide a valid wrangler.jsonc configuration.'];
  if (config.main !== 'src/index.js' || config.assets?.directory !== './web' || !config.assets?.run_worker_first?.includes('/api/*') || !config.assets?.run_worker_first?.includes('/oai')) errors.push('Keep Worker entry and API-first static asset routing configured.');
  if (config.d1_databases?.length !== 1 || config.d1_databases[0]?.binding !== 'DB' || !resourceId.test(config.d1_databases[0]?.database_id || '')) errors.push('Set d1_databases[0].database_id to the provisioned D1 database ID for binding DB.');
  if (config.kv_namespaces?.length !== 1 || config.kv_namespaces[0]?.binding !== 'EDGE_FEED_CACHE' || !resourceId.test(config.kv_namespaces[0]?.id || '')) errors.push('Set kv_namespaces[0].id to the provisioned KV namespace ID for binding EDGE_FEED_CACHE.');
  if (config.r2_buckets?.length !== 1 || config.r2_buckets[0]?.binding !== 'R2_BUCKET' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.r2_buckets[0]?.bucket_name || '')) errors.push('Set r2_buckets[0].bucket_name to a provisioned private R2 bucket for binding R2_BUCKET.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.vars?.OAI_ADMIN_EMAIL || '')) errors.push('Set vars.OAI_ADMIN_EMAIL to the approved public repository contact email.');
  if (config.vars?.CURATOR_SETUP_TOKEN !== undefined) errors.push('Never store CURATOR_SETUP_TOKEN in vars; provision it as a Worker secret.');
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const source = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    const preparing = process.argv.includes('--prepare');
    const config = preparing ? prepareDeployment(source, process.env) : source;
    const errors = validateDeployment(config, process.env);
    if (errors.length) {
      console.error(`Deployment blocked:\n${errors.map(error => `- ${error}`).join('\n')}`);
      process.exitCode = 1;
    } else if (preparing) {
      writeFileSync(new URL('../wrangler.release.json', import.meta.url), `${JSON.stringify(config, null, 2)}\n`, { flag: 'w', mode: 0o600 });
      console.log('Release binding configuration generated. Confirm remote resources, migrations, Worker secret, domain, and release approvals separately.');
    } else {
      console.log('Local binding and build configuration validated. Confirm remote resources, migrations, Worker secret, domain, and release approvals separately.');
    }
  } catch (error) {
    console.error(`Deployment blocked: cannot parse wrangler.jsonc (${error.message}).`);
    process.exitCode = 1;
  }
}
