'use strict';

const zlib = require('zlib');
const FIELDS = require('./fields.json');

// Files CloudFront access logs under logs/site=<site>/dt=YYYY-MM-DD/ so Athena can prune by site and day.
//
// Legacy standard logs: raw/<site>/<dist>.YYYY-MM-DD-HH.<id>.gz are moved unchanged (33 columns),
// up to LEGACY_LAST_HOUR; later ones are deleted because v2 covers them.
// Standard logging v2:  raw-v2/<site>/YYYY/MM/DD/<file> are rewritten to the same 33 columns plus
// c-country, asn and viewer-response-log-data (the visitor ID written by the visitor-id function).
const RAW_KEY = /^raw\/([a-z0-9-]+)\/([^/]+\.(\d{4}-\d{2}-\d{2})-\d{2}\.[^/]+\.gz)$/;
const LEGACY_HOUR = /\.(\d{4}-\d{2}-\d{2}-\d{2})\.[^/.]+\.gz$/;
// Every site has delivered v2 logs since this hour (UTC), so legacy logs for later hours would only
// duplicate them and are discarded. Logs for this hour itself were de-duplicated by edge request ID.
const LEGACY_LAST_HOUR = '2026-10-09-21';
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

function isRetiredLegacy(rawKey) {
  const hour = RAW_KEY.test(rawKey) && LEGACY_HOUR.exec(rawKey);
  return Boolean(hour) && hour[1] > LEGACY_LAST_HOUR;
}

function isV2(rawKey) {
  return rawKey.startsWith('raw-v2/');
}

// The sites log the Cookie header only for the dl_vid visitor ID, but CloudFront logs the whole header,
// including the sites' sign-in session cookies. Keep just the visitor ID so sessions are never stored
// beyond the unprocessed raw-v2/ file, which is deleted as soon as it is filed.
const VISITOR_COOKIE = /dl_vid=([a-z0-9]{8,40})/;

function redactCookie(value) {
  if (!value || value === '-') return '-';
  let decoded = value;
  try {
    decoded = decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    // Keep the raw value; the visitor ID never contains escapes.
  }
  const match = VISITOR_COOKIE.exec(decoded);
  return match ? `dl_vid=${match[1]}` : '-';
}

// Query parameters that carry secrets: share tokens (plan's ?token=), OAuth codes and state, signed URLs,
// passwords and keys. Their values are replaced; the names stay, and nothing reads the values (the
// dashboard only reads ?from=).
const SECRET_PARAM = /token|secret|passw|signature|session|credential|api_?key|jwt|^(code|state|nonce|sig|key|pwd|otp|ticket|auth|x-amz-[a-z-]+)$/i;

function safeDecode(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

// name=value&... with secret values replaced by "redacted". Separators may be raw or percent-encoded.
function redactQuery(query) {
  if (!query || query === '-') return query;
  return query.split(/(&|%26)/i).map((part) => {
    const eq = /=|%3D/i.exec(part);
    if (!eq || !SECRET_PARAM.test(safeDecode(part.slice(0, eq.index)).trim())) return part;
    return `${part.slice(0, eq.index + eq[0].length)}redacted`;
  }).join('');
}

// A referrer can be a page of the same site with a secret in its query (e.g. a plan share link).
function redactReferrer(value) {
  if (!value || value === '-') return value;
  const mark = /\?|%3F/i.exec(value);
  return mark ? value.slice(0, mark.index + mark[0].length) + redactQuery(value.slice(mark.index + mark[0].length)) : value;
}

const REDACT = { 'cs(Cookie)': redactCookie, 'cs-uri-query': redactQuery, 'cs(Referer)': redactReferrer };

// Applies the redactions above to an already filed log file, keeping every other byte as it is.
// Columns are found by the #Fields header (falling back to the configured order).
function redactLogText(text) {
  const columns = (names) => Object.keys(REDACT).map((name) => [names.indexOf(name), REDACT[name]]).filter(([i]) => i >= 0);
  let targets = columns(OUTPUT_FIELDS);
  return text.split('\n').map((line) => {
    if (line.startsWith('#Fields:')) {
      targets = columns(line.replace(/\r$/, '').slice('#Fields:'.length).trim().split(/\s+/));
      return line;
    }
    if (!line || line.startsWith('#')) return line;
    const cr = line.endsWith('\r');
    const values = (cr ? line.slice(0, -1) : line).split('\t');
    for (const [index, redact] of targets) {
      if (values[index] !== undefined) values[index] = redact(values[index]);
    }
    return values.join('\t') + (cr ? '\r' : '');
  }).join('\n');
}

// Synthetic probes: status.dliu.com checks every site as a guest every 15 minutes (dliu-status-bot/), and hourly from
// mainland China through Globalping, whose volunteer probes send a fixed user agent ("globalping probe (…)"); anyone
// else's Globalping tests are synthetic too. Their lines are dropped here, so they never reach the Bots page, Athena
// scans, the bot check or AbuseIPDB lookups.
const STATUS_BOT = /^(?:dliu-status-bot\/|globalping probe\b)/i;

function isStatusProbe(userAgent) {
  return Boolean(userAgent) && STATUS_BOT.test(safeDecode(safeDecode(userAgent)).trim());
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
    if (isStatusProbe(byName.get('cs(User-Agent)'))) continue;
    rows.push(OUTPUT_FIELDS.map((name) => {
      const value = byName.get(name);
      if (name === 'cs(Cookie)') return redactCookie(value);
      const clean = value === undefined || value === '' ? '-' : value.replace(/[\t\n]/g, ' ');
      return REDACT[name] ? REDACT[name](clean) : clean;
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
    if (isRetiredLegacy(key)) {
      console.log(JSON.stringify({ message: 'Discarding legacy log covered by v2', key }));
    } else if (isV2(key)) {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const text = gunzipIfNeeded(Buffer.from(await object.Body.transformToByteArray())).toString('utf8');
      const normalized = normalizeV2(text);
      // A file holding only status probes (or nothing) leaves no empty object behind.
      if (normalized !== OUTPUT_HEADER) {
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: target,
          Body: zlib.gzipSync(normalized),
          ContentType: 'application/gzip',
        }));
      }
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

module.exports = { handler, processEvent, targetKey, decodeKey, normalizeV2, redactCookie, redactQuery, redactReferrer, redactLogText, isStatusProbe, isRetiredLegacy, OUTPUT_FIELDS, LEGACY_LAST_HOUR };
