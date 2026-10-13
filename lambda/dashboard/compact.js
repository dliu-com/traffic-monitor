'use strict';

// Daily log merge (handler `compact.update`, runs at 01:30 UTC, after the 00:30 bot check).
// CloudFront writes hundreds of small log files a day, and Athena is paid per file it reads. Once the bot
// check has finished its last pass over a day (each run re-judges the last 3 days), that day's files for
// each site are merged into one file in a folder per month, archive/month=<YYYY-MM>/<site>_<day>.gz
// (Glue table cloudfront_logs_archive; Athena also pays per folder it lists), and the bots' requests are
// deleted for good: the same rule as the dashboard (queries.js): a crawler, script or missing user agent,
// or an IP judged a bot for that day (bots/dt=<day>/bots.json). People's requests are kept unchanged.
// So the newest 3 days always hold every request, bots included; days 4 and older hold people only.
//
// Each row gets two more columns, site and dt, since the folder no longer says them.
//
// Safety: the merged file is written before the files it replaces are deleted, and rows are de-duplicated by
// CloudFront's request ID, so a rerun after a failure (or a late log file) merges again without double counting.
// A day is merged only if the last bot check finished and started at least 3 days after it.
const zlib = require('zlib');
const { BOT, CATCH_UP_DAYS, COMPLETE_DAYS, isoDay, settings } = require('./queries');
const { readStatus } = require('./bots');

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// COMPLETE_DAYS (3): days kept complete (bots included), counting back from yesterday. A normal run looks at
// the CATCH_UP_DAYS (4) days before those, so late log files and missed runs are caught up; the dashboard
// (queries.js layout) reads daily folders for exactly those days, so nothing still waiting is missed.
const MAX_DAYS = 400;
const ARCHIVE_PREFIX = 'archive/';
const archiveKey = (site, day) => `${ARCHIVE_PREFIX}month=${day.slice(0, 7)}/${site}_${day}.gz`;
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
const HEADER = `#Version: 1.0\n#Fields: ${COLUMNS.join(' ')} site dt\n`;
const IP = COLUMNS.indexOf('c-ip');
const UA = COLUMNS.indexOf('cs(User-Agent)');
const REQUEST_ID = COLUMNS.indexOf('x-edge-request-id');
const BOT_UA = new RegExp(BOT);

let s3Client;
const s3 = () => {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({});
  }
  return s3Client;
};

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

// Keeps people's rows and drops bots' rows and repeated requests (same CloudFront request ID).
function mergeRows(files, botIps) {
  const seen = new Set();
  const kept = [];
  let bots = 0;
  let duplicates = 0;
  for (const rows of files) {
    for (const row of rows) {
      const id = row[REQUEST_ID];
      if (id !== '-') {
        if (seen.has(id)) {
          duplicates++;
          continue;
        }
        seen.add(id);
      }
      if (botIps.has(row[IP]) || isAgent(row[UA])) bots++;
      else kept.push(row);
    }
  }
  return { kept, bots, duplicates };
}

const toFile = (rows, site, day) => zlib.gzipSync(HEADER + rows.map((row) => `${row.join('\t')}\t${site}\t${day}\n`).join(''));

// The days to merge, oldest first. By default the 4 days before the newest 3 complete days; event.from/to
// (YYYY-MM-DD) merge older days once, e.g. after the first deploy. Never newer than the last finished bot
// check allows.
function daysToMerge(event, now, status) {
  if (!status || status.state !== 'done' || !DAY.test(isoDay(Date.parse(status.started) || 0))) return [];
  const newest = Math.min(Date.parse(isoDay(now)) - (COMPLETE_DAYS + 1) * DAY_MS, Date.parse(isoDay(Date.parse(status.started))) - COMPLETE_DAYS * DAY_MS);
  let from = newest - (CATCH_UP_DAYS - 1) * DAY_MS;
  let to = newest;
  if (event && (event.from !== undefined || event.to !== undefined)) {
    if (!DAY.test(String(event.from)) || !DAY.test(String(event.to))) throw new Error('from and to must be YYYY-MM-DD');
    from = Date.parse(event.from);
    to = Math.min(Date.parse(event.to), newest);
    if ((to - from) / DAY_MS >= MAX_DAYS) throw new Error(`At most ${MAX_DAYS} days at a time`);
  }
  const days = [];
  for (let day = from; day <= to; day += DAY_MS) days.push(isoDay(day));
  return days;
}

async function listKeys(client, bucket, prefix) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const keys = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
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

// The IPs judged bots on a day, or null when that day has not been judged (then it is not merged).
async function botIpsFor(client, bucket, day) {
  try {
    const text = (await readObject(client, bucket, `bots/dt=${day}/bots.json`)).toString('utf8');
    const ips = new Set();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const verdict = JSON.parse(line);
      if (verdict && typeof verdict.ip === 'string') ips.add(verdict.ip);
    }
    return ips;
  } catch (error) {
    if (error.name === 'NoSuchKey') return null;
    throw error;
  }
}

// Merges one site's day: the daily folder's files, plus the archive file if an earlier run made one (a late
// log file), into the archive file; then deletes the daily files.
async function mergeDay(client, bucket, site, day, botIps, dryRun) {
  const prefix = `logs/site=${site}/dt=${day}/`;
  const keys = (await listKeys(client, bucket, prefix)).filter((key) => key.endsWith('.gz') || key.endsWith('.log'));
  if (!keys.length) return null;
  const target = archiveKey(site, day);
  const files = [];
  try {
    files.push(parseLog(gunzipIfNeeded(await readObject(client, bucket, target)).toString('utf8')));
  } catch (error) {
    if (error.name !== 'NoSuchKey') throw error;
  }
  for (const key of keys) files.push(parseLog(gunzipIfNeeded(await readObject(client, bucket, key)).toString('utf8')));
  const { kept, bots, duplicates } = mergeRows(files, botIps);
  const result = { site, day, key: target, files: keys.length, rows: files.reduce((n, rows) => n + rows.length, 0), kept: kept.length, bots, duplicates };
  if (dryRun) return result;
  const { DeleteObjectsCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: target, Body: toFile(kept, site, day), ContentType: 'application/gzip' }));
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const answer = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
    if (answer && answer.Errors && answer.Errors.length) throw new Error(`Could not delete ${answer.Errors.length} merged files in ${prefix}`);
  }
  return result;
}

async function update(event = {}, deps = {}) {
  const env = deps.env || process.env;
  const bucket = deps.bucket || env.LOGS_BUCKET;
  if (!bucket) throw new Error('LOGS_BUCKET is not set');
  const client = deps.s3 || s3();
  const now = deps.now ?? Date.now();
  const dryRun = Boolean(event && event.dryRun === true);
  // Backfill only: days from before the bot check existed have no verdicts; merge them dropping agent bots only
  // (which is all the dashboard ever hid on those days).
  const unjudgedAsAgents = Boolean(event && event.unjudged === 'agents' && event.from !== undefined);
  const status = await readStatus(client, bucket);
  const days = daysToMerge(event, now, status);
  if (!days.length) {
    console.log(JSON.stringify({ message: 'Log merge skipped: the bot check has not finished', state: status && status.state }));
    return { days: [], merged: [], skipped: 'bot check not finished' };
  }
  const merged = [];
  const unjudged = [];
  for (const day of days) {
    const botIps = (await botIpsFor(client, bucket, day)) || (unjudgedAsAgents ? new Set() : null);
    if (!botIps) {
      unjudged.push(day);
      continue;
    }
    for (const site of settings(env).sites) {
      const result = await mergeDay(client, bucket, site, day, botIps, dryRun);
      if (result) merged.push(result);
    }
  }
  const totals = merged.reduce((t, r) => ({ files: t.files + r.files, kept: t.kept + r.kept, bots: t.bots + r.bots, duplicates: t.duplicates + r.duplicates }),
    { files: 0, kept: 0, bots: 0, duplicates: 0 });
  console.log(JSON.stringify({ message: dryRun ? 'Log merge dry run' : 'Logs merged', days, unjudged, folders: merged.length, ...totals }));
  return { days, unjudged, dryRun, merged, ...totals };
}

module.exports = { ARCHIVE_PREFIX, COLUMNS, COMPLETE_DAYS, HEADER, archiveKey, daysToMerge, isAgent, mergeRows, parseLog, toFile, update };
