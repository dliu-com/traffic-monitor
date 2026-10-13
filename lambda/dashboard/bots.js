'use strict';

// Daily bot classifier (handler `bots.update`, runs at 00:30 UTC). For each of the last 7 days it reads
// what every IP did that day and saves the IPs that count as bots, with the reason, as JSON lines under
// s3://<log bucket>/bots/dt=<day>/bots.json (Glue table bot_ips). The dashboard joins those verdicts by day
// and IP, so requests from the current day count as people until the next run (crawler user agents are
// still caught as they arrive; see queries.js). Reasons, the first that applies:
//   hosting  - the IP's network (ASN) is a cloud or hosting network (hosting.js, refreshed weekly)
//   probe    - it asked for paths only vulnerability scanners ask for
//   abuse    - AbuseIPDB scores it as abusive, or says it is a Tor exit or a data centre
//   headless - it never loaded a page's scripts, styles or fonts and never sent the visitor cookie;
//              every real browser does one or the other, whatever it is called
// AbuseIPDB: each run collects the distinct IPs still counted as people whose last result is missing or
// over 30 days old, newest day and busiest first, and looks each up once (up to 900 a run; the free plan
// allows 1,000 a day, reset at midnight UTC). It stops early on HTTP 429 or when the remaining allowance
// reaches 0; the rest wait for the next run. Results are saved under reputation/dt=<day>/ (Glue table
// ip_reputation, kept 180 days). The key lives in SSM; without it that step is skipped.

const net = require('net');
const { runQuery } = require('./athena');
const { EXCLUDED, cleanName, loadHosting, validAsn } = require('./hosting');
const { BOT, isoDay, settings } = require('./queries');

const API = 'https://api.abuseipdb.com/api/v2/check';
const BOTS_PREFIX = 'bots/';
const STATUS_KEY = 'bots/status.json';
const REPUTATION_PREFIX = 'reputation/';
const DAY_MS = 24 * 60 * 60 * 1000;
// Each run re-judges the last week, so IPs left unchecked when the daily AbuseIPDB limit ran out are
// checked on a later run and their days' verdicts updated.
const DEFAULT_DAYS = 7;
const MAX_DAYS = 400;
const REPUTATION_DAYS = 120;
const RECHECK_DAYS = 30;
const MAX_AGE_DAYS = 90;
const MAX_CHECKS = 900;
const CONCURRENCY = 4;
const MAX_FAILURES = 20;
const TIMEOUT_MS = 10000;
const MAX_BYTES = 64 * 1024;
const MAX_ROWS = 1000000;
const QUERY_DEADLINE_MS = 5 * 60 * 1000;

const ABUSE_SCORE = 50;
const DATA_CENTER = 'Data Center/Web Hosting/Transit';
// Files every real browser loads with a page (images and icons are left out: link-preview bots fetch those).
const PAGE_FILE = '\\.(js|mjs|css|woff2?|ttf|otf|wasm)$';
// Paths only vulnerability scanners ask for: these sites are static, with no PHP, admin pages or dotfiles.
const PROBE = '(^|/)\\.(env|git|svn|hg|aws|ssh|vscode|idea|docker|ht|npmrc|terraform|ds_store)|wp-(login|admin|includes|content|config|json)|xmlrpc|phpmyadmin|cgi-bin|sftp-config|\\.(php|asp|aspx|jsp|cgi)($|/)|\\.(sql|bak|swp|save|old|orig|tfstate)$';
const REASONS = ['hosting', 'probe', 'abuse', 'headless'];

class RateLimited extends Error {}

let ssmClient;
let s3Client;
const ssm = () => {
  if (!ssmClient) {
    const { SSMClient } = require('@aws-sdk/client-ssm');
    ssmClient = new SSMClient({});
  }
  return ssmClient;
};
const s3 = () => {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({});
  }
  return s3Client;
};

const keyName = (env = process.env) => `${env.PARAMETER_PREFIX || '/traffic-monitor'}/abuseipdb-api-key`;

async function apiKey(client, env = process.env) {
  const { GetParameterCommand } = require('@aws-sdk/client-ssm');
  try {
    const { Parameter } = await client.send(new GetParameterCommand({ Name: keyName(env), WithDecryption: true }));
    return (Parameter && Parameter.Value || '').trim() || null;
  } catch (error) {
    if (error.name === 'ParameterNotFound') return null;
    throw error;
  }
}

const validIp = (value) => typeof value === 'string' && value.length <= 45 && net.isIP(value) !== 0;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The days to classify: the `days` full days before today (UTC), newest first, plus today so far when
// `includeToday` is set (runs started from the dashboard).
function daysToClassify(event, now) {
  const requested = event && event.days !== undefined ? Number(event.days) : DEFAULT_DAYS;
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_DAYS) throw new Error(`days must be 1-${MAX_DAYS}`);
  const today = Date.parse(isoDay(now));
  const days = Array.from({ length: requested }, (_, i) => isoDay(today - (i + 1) * DAY_MS));
  return event && event.includeToday === true ? [isoDay(today), ...days] : days;
}

// One row per day and IP: its network, what it asked for, and its latest AbuseIPDB result.
function featuresSql(startDay, endDay, env = process.env) {
  const { database, table, reputationTable } = settings(env);
  if (!DAY.test(startDay) || !DAY.test(endDay)) throw new Error('Invalid day');
  const reputationSince = isoDay(Date.parse(startDay) - REPUTATION_DAYS * DAY_MS);
  return `WITH l AS (
    SELECT dt, c_ip AS ip,
      from_iso8601_timestamp(concat(cast("date" AS varchar), 'T', time, 'Z')) AS ts,
      lower(url_decode(cs_uri_stem)) AS path,
      lower(coalesce(url_decode(cs_user_agent), '')) AS ua,
      regexp_like(url_decode(cs_cookie), 'dl_vid=[a-z0-9]{8,40}') AS has_cookie,
      CASE WHEN regexp_like(asn, '^[0-9]{1,10}$') THEN asn END AS asn
    FROM "${database}"."${table}"
    WHERE dt BETWEEN '${startDay}' AND '${endDay}'
  ), f AS (
    SELECT dt, ip, count(*) AS requests,
      count_if(NOT (ua IN ('', '-') OR regexp_like(ua, '${BOT}'))) AS browser_requests,
      max_by(asn, ts) FILTER (WHERE asn IS NOT NULL) AS asn,
      bool_or(regexp_like(path, '${PROBE}')) AS probe,
      bool_or(regexp_like(path, '${PAGE_FILE}') OR coalesce(has_cookie, false)) AS loads_page
    FROM l GROUP BY dt, ip
  ), rep AS (
    SELECT ip AS rep_ip, max_by(score, checked) AS score, max_by(usage_type, checked) AS usage_type,
      max_by(is_tor, checked) AS is_tor, max(checked) AS checked
    FROM "${database}"."${reputationTable}"
    WHERE dt >= '${reputationSince}'
    GROUP BY ip
  )
SELECT f.*, score, usage_type, is_tor, checked
FROM f LEFT JOIN rep ON rep_ip = ip`;
}

const truthy = (value) => value === true || value === 'true';

function isAbusive(reputation, asn) {
  if (!reputation) return false;
  const score = Number(reputation.score);
  return (Number.isFinite(score) && score >= ABUSE_SCORE) || truthy(reputation.is_tor)
    || (reputation.usage_type === DATA_CENTER && !Object.hasOwn(EXCLUDED, String(asn)));
}

// Why an IP counts as a bot on one day, or null for a person. `reputation` is its latest AbuseIPDB result.
function verdict(row, networks, reputation) {
  const asn = row.asn != null ? validAsn(row.asn) : null;
  if (asn && Object.hasOwn(networks, String(asn))) return 'hosting';
  if (truthy(row.probe)) return 'probe';
  if (isAbusive(reputation, asn)) return 'abuse';
  if (!truthy(row.loads_page)) return 'headless';
  return null;
}

const whole = (value, max) => {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(Math.max(n, 0), max) : 0;
};
const DOMAIN = /^[a-z0-9.-]{1,253}$/i;

// One saved AbuseIPDB result. Only plain, length-limited values are kept; the dashboard shows them as text.
function toResult(ip, body, checked) {
  const data = body && body.data;
  if (!data || typeof data !== 'object') throw new Error('Unexpected AbuseIPDB response');
  return {
    ip,
    score: whole(data.abuseConfidenceScore, 100),
    reports: whole(data.totalReports, 1e9),
    usage_type: typeof data.usageType === 'string' ? cleanName(data.usageType) || null : null,
    isp: typeof data.isp === 'string' ? cleanName(data.isp) || null : null,
    domain: typeof data.domain === 'string' && DOMAIN.test(data.domain) ? data.domain.toLowerCase() : null,
    is_tor: data.isTor === true,
    checked,
  };
}

async function check(ip, key, fetchImpl) {
  const url = `${API}?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=${MAX_AGE_DAYS}`;
  const response = await fetchImpl(url, {
    headers: { Key: key, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 429) throw new RateLimited('AbuseIPDB daily limit reached');
  if (!response.ok) throw new Error(`AbuseIPDB returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('AbuseIPDB response too large');
  const remaining = response.headers && response.headers.get ? response.headers.get('x-ratelimit-remaining') : null;
  return { body: JSON.parse(text), lastAllowed: remaining === '0' };
}

// Looks up IPs one after another on a few workers; stops at the daily limit or after repeated failures.
async function checkAll(ips, key, fetchImpl, checked) {
  const results = [];
  let next = 0;
  let failures = 0;
  let stopped = null;
  const worker = async () => {
    while (!stopped && next < ips.length) {
      const ip = ips[next++];
      try {
        const { body, lastAllowed } = await check(ip, key, fetchImpl);
        results.push(toResult(ip, body, checked));
        if (lastAllowed) stopped = 'daily limit reached';
      } catch (error) {
        if (error instanceof RateLimited) stopped = 'daily limit reached';
        else if (++failures >= MAX_FAILURES) stopped = `too many failures (last: ${error.message})`;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { results, failures, stopped };
}

async function put(client, bucket, key, lines) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: lines.map((line) => JSON.stringify(line)).join('\n') + (lines.length ? '\n' : ''),
    ContentType: 'application/x-ndjson',
  }));
}

async function writeStatus(client, bucket, status) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: STATUS_KEY, Body: JSON.stringify(status), ContentType: 'application/json',
  }));
}

// The last run, for the dashboard: { state: running|done|failed, trigger, started, finished?, summary?, error? }.
async function readStatus(client, bucket) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: STATUS_KEY }));
    const status = JSON.parse(await result.Body.transformToString());
    return status && typeof status === 'object' ? status : null;
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.name === 'AccessDenied' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function update(event = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now ?? Date.now();
  const bucket = deps.bucket || env.BOTS_BUCKET;
  if (!bucket) throw new Error('BOTS_BUCKET is not set');
  const days = daysToClassify(event, now);
  const client = deps.s3 || s3();
  const trigger = event && event.trigger === 'dashboard' ? 'dashboard' : 'schedule';
  const started = new Date(now).toISOString();
  await writeStatus(client, bucket, { state: 'running', trigger, started });
  try {
    const summary = await classify(days, now, env, bucket, client, deps);
    await writeStatus(client, bucket, { state: 'done', trigger, started, finished: new Date(deps.now ?? Date.now()).toISOString(), summary });
    return summary;
  } catch (error) {
    await writeStatus(client, bucket, { state: 'failed', trigger, started, finished: new Date(deps.now ?? Date.now()).toISOString(), error: 'The bot check failed; see the BotClassifier logs.' })
      .catch(() => {});
    throw error;
  }
}

async function classify(days, now, env, bucket, client, deps) {
  const networks = await (deps.loadHosting || loadHosting)();
  const query = deps.runQuery || runQuery;
  const rows = (await query(featuresSql(days[days.length - 1], days[0], env), { maxRows: MAX_ROWS, deadlineMs: QUERY_DEADLINE_MS }))
    .filter((row) => validIp(row.ip) && days.includes(row.dt));

  // AbuseIPDB: IPs still counted as people (using a browser user agent) without a recent result, newest day first.
  const reputation = new Map();
  for (const row of rows) if (row.checked && !reputation.has(row.ip)) reputation.set(row.ip, row);
  const checked = new Date(now).toISOString().slice(0, 19) + 'Z';
  const recheck = new Date(now - RECHECK_DAYS * DAY_MS).toISOString().slice(0, 19) + 'Z';
  const key = await apiKey(deps.ssm || ssm(), env);
  const abuse = { checked: 0, failures: 0, stopped: key ? null : 'no API key' };
  if (key) {
    const wanted = new Set();
    const ordered = [...rows].sort((a, b) => b.dt.localeCompare(a.dt) || Number(b.requests) - Number(a.requests));
    for (const row of ordered) {
      if (wanted.size >= MAX_CHECKS) break;
      if (Number(row.browser_requests) === 0 || verdict(row, networks, reputation.get(row.ip))) continue;
      const last = reputation.get(row.ip);
      if (!last || !(last.checked >= recheck)) wanted.add(row.ip);
    }
    const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
    const { results, failures, stopped } = await checkAll([...wanted], key, fetchImpl, checked);
    if (results.length) await put(client, bucket, `${REPUTATION_PREFIX}dt=${isoDay(now)}/${checked.replace(/[-:]/g, '')}.json`, results);
    for (const result of results) reputation.set(result.ip, result);
    Object.assign(abuse, { wanted: wanted.size, checked: results.length, left: wanted.size - results.length, failures, stopped });
  }

  // One file per day that has requests, replacing the last run's verdicts.
  const byDay = new Map();
  for (const row of rows) {
    const reason = verdict(row, networks, reputation.get(row.ip));
    if (!byDay.has(row.dt)) byDay.set(row.dt, []);
    if (reason) byDay.get(row.dt).push({ ip: row.ip, reason });
  }
  const counts = Object.fromEntries(REASONS.map((reason) => [reason, 0]));
  for (const [day, bots] of byDay) {
    await put(client, bucket, `${BOTS_PREFIX}dt=${day}/bots.json`, bots);
    for (const bot of bots) counts[bot.reason]++;
  }
  const summary = { from: days[days.length - 1], to: days[0], days: byDay.size, ips: rows.length, bots: counts, abuseipdb: abuse };
  console.log(JSON.stringify({ message: 'Bot classification finished', ...summary }));
  return summary;
}

module.exports = { STATUS_KEY, readStatus, ABUSE_SCORE, DATA_CENTER, MAX_CHECKS, PAGE_FILE, PROBE, RateLimited, apiKey, check, daysToClassify, featuresSql, isAbusive, toResult, update, validIp, verdict };
