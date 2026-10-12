'use strict';

// Cloud and hosting networks (by ASN). Requests from these are servers and scripts, not people, so the
// dashboard counts them as bots. A weekly job (handler `hosting.update`) merges public lists into
// s3://<log bucket>/hosting/asns.json; the dashboard reads that copy, cached in memory, and falls back to
// BUILT_IN if it is missing. Nothing from the lists reaches SQL except validated numbers.

const KEY = 'hosting/asns.json';
const MAX_ASN = 4294967295;
const CACHE_MS = 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const MIN_SOURCE = 200;
const MIN_TOTAL = 300;
const MAX_BYTES = 2 * 1024 * 1024;

const SOURCES = [
  { name: 'brianhama/bad-asn-list', url: 'https://raw.githubusercontent.com/brianhama/bad-asn-list/master/bad-asn-list.csv', format: 'csv' },
  { name: 'X4BNet/lists_vpn', url: 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/input/datacenter/ASN.txt', format: 'asn-comment' },
];

// Always on the list, and their names win over the public lists' names.
const BUILT_IN = {
  16509: 'Amazon AWS', 14618: 'Amazon AWS', 8987: 'Amazon AWS',
  15169: 'Google', 396982: 'Google Cloud',
  8075: 'Microsoft Azure',
  31898: 'Oracle Cloud',
  14061: 'DigitalOcean',
  16276: 'OVHcloud',
  24940: 'Hetzner', 213230: 'Hetzner',
  63949: 'Akamai Linode',
  20473: 'Vultr',
  51167: 'Contabo',
  12876: 'Scaleway',
  8560: 'IONOS',
  60781: 'Leaseweb', 28753: 'Leaseweb',
  132203: 'Tencent Cloud', 45090: 'Tencent Cloud',
  45102: 'Alibaba Cloud', 37963: 'Alibaba Cloud',
  136907: 'Huawei Cloud', 55990: 'Huawei Cloud',
  396986: 'ByteDance',
  398324: 'Censys', 398705: 'Censys',
  211298: 'Internet Measurement',
};

// Never counted as hosting: these carry real people (Cloudflare WARP, iCloud Private Relay egress via
// Akamai, Fastly and Apple). They win over every list.
const EXCLUDED = {
  13335: 'Cloudflare', 209242: 'Cloudflare',
  36183: 'Akamai (iCloud Private Relay)',
  54113: 'Fastly',
  714: 'Apple', 6185: 'Apple',
};

const validAsn = (value) => {
  const text = String(value).trim().replace(/^AS/i, '');
  if (!/^[0-9]{1,10}$/.test(text)) return null;
  const asn = Number(text);
  return asn >= 1 && asn <= MAX_ASN ? asn : null;
};

// A short, plain display name: no URLs, only letters, digits, spaces and . , & ( ) ' / -
function cleanName(value) {
  const name = String(value || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[^\p{L}\p{N} .,&()'/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.-]+|[\s,(-]+$/g, '');
  return name.slice(0, 60).trim();
}

// brianhama: `ASN,Entity` header, then `1442,"Name"`.
function parseCsv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*"?(\d{1,10})"?\s*,\s*(.*)$/);
    const asn = match && validAsn(match[1]);
    if (asn) out[asn] = cleanName(match[2].replace(/^"|"$/g, '').replace(/""/g, '"'));
  }
  return out;
}

// X4BNet: `AS45090 # comment`.
function parseAsnComment(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*AS(\d{1,10})\b\s*(?:#\s*(.*))?$/i);
    const asn = match && validAsn(match[1]);
    if (asn) out[asn] = cleanName(match[2]);
  }
  return out;
}

const PARSERS = { csv: parseCsv, 'asn-comment': parseAsnComment };

// Built-in names first, then earlier sources' names; excluded networks removed last.
function merge(lists) {
  const networks = {};
  for (const list of [BUILT_IN, ...lists]) {
    for (const [key, name] of Object.entries(list)) {
      const asn = validAsn(key);
      if (asn && !networks[asn]) networks[asn] = cleanName(name) || `AS${asn}`;
    }
  }
  for (const key of Object.keys(EXCLUDED)) delete networks[key];
  return networks;
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('Too large');
  return text;
}

let s3Client;
function s3() {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({});
  }
  return s3Client;
}

// Weekly job: download, validate, merge, and save. Throws (keeping the last good copy) if the result looks wrong.
async function update(_event, deps = {}) {
  const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
  const client = deps.s3 || s3();
  const bucket = deps.bucket || process.env.HOSTING_BUCKET;
  if (!bucket) throw new Error('HOSTING_BUCKET is not set');
  const lists = [];
  const sources = {};
  for (const source of SOURCES) {
    try {
      const list = PARSERS[source.format](await fetchText(source.url, fetchImpl));
      const count = Object.keys(list).length;
      if (count < MIN_SOURCE) throw new Error(`only ${count} networks`);
      lists.push(list);
      sources[source.name] = count;
    } catch (error) {
      console.warn(JSON.stringify({ message: 'Hosting list source skipped', source: source.name, error: error.message }));
    }
  }
  if (!lists.length) throw new Error('No hosting list source could be read; keeping the last copy');
  const networks = merge(lists);
  const total = Object.keys(networks).length;
  if (total < MIN_TOTAL) throw new Error(`Merged hosting list has only ${total} networks; keeping the last copy`);
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const body = JSON.stringify({ updated: new Date(deps.now ?? Date.now()).toISOString(), sources, networks });
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: KEY, Body: body, ContentType: 'application/json' }));
  console.log(JSON.stringify({ message: 'Hosting list updated', sources, total }));
  return { sources, total };
}

let cached = null;
let cachedUntil = 0;

// The current list for the dashboard: the S3 copy (re-checked hourly) merged with BUILT_IN, or BUILT_IN alone.
async function loadHosting(deps = {}) {
  const now = deps.now ?? Date.now();
  if (cached && now < cachedUntil) return cached;
  const bucket = deps.bucket !== undefined ? deps.bucket : process.env.HOSTING_BUCKET;
  if (!bucket) return merge([]);
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const result = await (deps.s3 || s3()).send(new GetObjectCommand({ Bucket: bucket, Key: KEY }));
    const data = JSON.parse(await result.Body.transformToString());
    if (!data || typeof data.networks !== 'object') throw new Error('Unexpected format');
    cached = merge([data.networks]);
    cachedUntil = now + CACHE_MS;
  } catch (error) {
    console.warn(JSON.stringify({ message: 'Using the built-in hosting list', error: error.message }));
    cached = cached || merge([]);
    cachedUntil = now + RETRY_MS;
  }
  return cached;
}

function resetCache() {
  cached = null;
  cachedUntil = 0;
}

module.exports = { BUILT_IN, EXCLUDED, KEY, SOURCES, cleanName, loadHosting, merge, parseAsnComment, parseCsv, resetCache, update, validAsn };
