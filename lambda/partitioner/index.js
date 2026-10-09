'use strict';

const zlib = require('zlib');
const FIELDS = require('./fields.json');

// Files CloudFront access logs under logs/site=<site>/dt=YYYY-MM-DD/ so Athena can prune by site and day.
//
// Legacy standard logs: raw/<site>/<dist>.YYYY-MM-DD-HH.<id>.gz are moved unchanged (33 columns).
// Standard logging v2:  raw-v2/<site>/YYYY/MM/DD/<file> are rewritten to the same 33 columns plus
// c-country, asn and viewer-response-log-data (the visitor ID written by the visitor-id function).
const RAW_KEY = /^raw\/([a-z0-9-]+)\/([^/]+\.(\d{4}-\d{2}-\d{2})-\d{2}\.[^/]+\.gz)$/;
const V2_KEY = /^raw-v2\/([a-z0-9-]+)\/(\d{4})\/(\d{2})\/(\d{2})\/([A-Za-z0-9._-]+)$/;
const OUTPUT_FIELDS = [...FIELDS.legacy, ...FIELDS.added];
const OUTPUT_HEADER = `#Version: 1.0\n#Fields: ${OUTPUT_FIELDS.join(' ')}\n`;

function targetKey(rawKey) {
  const legacy = RAW_KEY.exec(rawKey);
  if (legacy) {
    const [, site, file, day] = legacy;
    return `logs/site=${site}/dt=${day}/${file}`;
  }
  const v2 = V2_KEY.exec(rawKey);
  if (v2) {
    const [, site, yyyy, mm, dd, file] = v2;
    const name = file.endsWith('.gz') ? file : `${file}.gz`;
    return `logs/site=${site}/dt=${yyyy}-${mm}-${dd}/v2-${name}`;
  }
  return null;
}

function isV2(rawKey) {
  return rawKey.startsWith('raw-v2/');
}

function decodeKey(key) {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}

// Reorders a v2 log file into the table's column order. Columns are matched by the #Fields header
// (falling back to the configured order), so a reordered or extended delivery still lines up.
function normalizeV2(text) {
  let names = OUTPUT_FIELDS;
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
    rows.push(OUTPUT_FIELDS.map((name) => {
      const value = byName.get(name);
      return value === undefined || value === '' ? '-' : value.replace(/[\t\n]/g, ' ');
    }).join('\t'));
  }
  return OUTPUT_HEADER + rows.map((row) => `${row}\n`).join('');
}

function gunzipIfNeeded(buffer) {
  return buffer.length > 1 && buffer[0] === 0x1f && buffer[1] === 0x8b ? zlib.gunzipSync(buffer) : buffer;
}

let s3Client;
function client() {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({});
  }
  return s3Client;
}

async function processEvent(event, s3) {
  const { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
  for (const record of event.Records || []) {
    const bucket = record.s3.bucket.name;
    const key = decodeKey(record.s3.object.key);
    const target = targetKey(key);
    if (!target) {
      console.warn(JSON.stringify({ message: 'Skipping unexpected key', key }));
      continue;
    }
    if (isV2(key)) {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const text = gunzipIfNeeded(Buffer.from(await object.Body.transformToByteArray())).toString('utf8');
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: target,
        Body: zlib.gzipSync(normalizeV2(text)),
        ContentType: 'application/gzip',
      }));
    } else {
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: target,
        CopySource: `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`,
      }));
    }
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}

// Keep the Lambda entry point at one argument: the Node.js runtime treats 3-argument
// handlers as callback-style and passes the callback as the third argument.
async function handler(event) {
  return processEvent(event, client());
}

module.exports = { handler, processEvent, targetKey, decodeKey, normalizeV2, OUTPUT_FIELDS };
