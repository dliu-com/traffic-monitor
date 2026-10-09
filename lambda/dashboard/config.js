'use strict';

const PREFIX = process.env.PARAMETER_PREFIX || '/traffic-monitor';
const NAMES = ['entra-tenant-id', 'entra-client-id', 'entra-client-secret', 'allowed-users'];
const TTL_MS = 5 * 60 * 1000;

let cached;
let cachedAt = 0;

let ssmClient;
function client() {
  if (!ssmClient) {
    const { SSMClient } = require('@aws-sdk/client-ssm');
    ssmClient = new SSMClient({});
  }
  return ssmClient;
}

function parseAllowed(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

async function loadConfig(ssm = client(), now = Date.now()) {
  if (cached && now - cachedAt < TTL_MS) return cached;
  const { GetParametersCommand } = require('@aws-sdk/client-ssm');
  const result = await ssm.send(new GetParametersCommand({
    Names: NAMES.map((name) => `${PREFIX}/${name}`),
    WithDecryption: true,
  }));
  const values = Object.fromEntries((result.Parameters || []).map((p) => [p.Name.slice(PREFIX.length + 1), p.Value]));
  const missing = NAMES.filter((name) => !values[name]);
  if (missing.length) {
    throw new Error(`Missing SSM parameters under ${PREFIX}: ${missing.join(', ')}. Run "make set-secrets".`);
  }
  cached = {
    tenantId: values['entra-tenant-id'].trim(),
    clientId: values['entra-client-id'].trim(),
    clientSecret: values['entra-client-secret'],
    allowedUsers: parseAllowed(values['allowed-users']),
  };
  cachedAt = now;
  return cached;
}

function resetConfigCache() {
  cached = undefined;
  cachedAt = 0;
}

module.exports = { loadConfig, parseAllowed, resetConfigCache };
