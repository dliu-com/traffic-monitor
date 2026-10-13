'use strict';

// Reading the partitioned CloudFront log files (logs/site=<site>/dt=<day>/*.gz), shared by the log merge
// (compact.js) and the bot check (bot-state.js).

const zlib = require('zlib');
const { BOT } = require('./queries');

// The 36 log columns in table order: CloudFront's 33 standard fields, then the 3 the partitioner adds
// (lambda/partitioner/fields.json; a test keeps the two lists equal).
const COLUMNS = [
  'date', 'time', 'x-edge-location', 'sc-bytes', 'c-ip', 'cs-method', 'cs(Host)', 'cs-uri-stem',
  'sc-status', 'cs(Referer)', 'cs(User-Agent)', 'cs-uri-query', 'cs(Cookie)', 'x-edge-result-type',
  'x-edge-request-id', 'x-host-header', 'cs-protocol', 'cs-bytes', 'time-taken', 'x-forwarded-for',
  'ssl-protocol', 'ssl-cipher', 'x-edge-response-result-type', 'cs-protocol-version', 'fle-status',
  'fle-encrypted-fields', 'c-port', 'time-to-first-byte', 'x-edge-detailed-result-type',
  'sc-content-type', 'sc-content-len', 'sc-range-start', 'sc-range-end',
  'c-country', 'asn', 'viewer-response-log-data',
];
const BOT_UA = new RegExp(BOT);

// Like Athena's url_decode, but never throws on a malformed escape.
function urlDecode(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

// The same test as the dashboard's "agent" reason: no user agent, or a crawler or script.
function isAgent(ua) {
  const decoded = urlDecode(ua || '');
  return decoded === '' || decoded === '-' || BOT_UA.test(decoded.toLowerCase());
}

// One log file's rows, in table column order. Columns are matched by the file's #Fields header, so older
// files without the 3 added columns get '-' for them.
function parseLog(text) {
  let names = COLUMNS;
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.startsWith('#Fields:')) {
      names = trimmed.slice('#Fields:'.length).trim().split(/\s+/);
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    const values = trimmed.split('\t');
    const byName = new Map(names.map((name, i) => [name, values[i]]));
    rows.push(COLUMNS.map((name) => {
      const value = byName.get(name);
      return value === undefined || value === '' ? '-' : value;
    }));
  }
  return rows;
}

const gunzipIfNeeded = (buffer) => (buffer.length > 1 && buffer[0] === 0x1f && buffer[1] === 0x8b ? zlib.gunzipSync(buffer) : buffer);

async function listKeys(client, bucket, prefix, startAfter) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const keys = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, StartAfter: startAfter, ContinuationToken: token }));
    for (const object of page.Contents || []) keys.push(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function readObject(client, bucket, key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await result.Body.transformToByteArray());
}

const isLogFile = (key) => key.endsWith('.gz') || key.endsWith('.log');

module.exports = { COLUMNS, gunzipIfNeeded, isAgent, isLogFile, listKeys, parseLog, readObject, urlDecode };
