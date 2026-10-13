'use strict';

// Bot classifier (handler `bots.update`), run every 6 hours (00:30, 06:30, 12:30 and 18:30 UTC) and from
// the dashboard. For today and each of the 3 days before it, it works out what every IP did that day (from
// log files no earlier run has read, added to counts kept in bot-state/; see bot-state.js) and saves
// the IPs that count as bots, with the reason, as JSON lines under s3://<log bucket>/bots/dt=<day>/bots.json
// (Glue table bot_ips). The dashboard joins those verdicts by day and IP, so requests since the last run
// count as people until the next one (crawler user agents are still caught as they arrive; see queries.js).
// Reasons, the first that applies:
//   hosting  - the IP's network (ASN) is a cloud or hosting network (hosting.js, refreshed weekly)
//   probe    - it asked for paths only vulnerability scanners ask for
//   abuse    - AbuseIPDB scores it as abusive, or says it is a Tor exit or a data centre
//   headless - it never loaded a page's scripts, styles or fonts and never sent the visitor cookie;
//              every real browser does one or the other, whatever it is called
// AbuseIPDB: each run collects the distinct IPs seen in those days that are still counted as people and
// have no result from the last 30 days, newest day and busiest first, and looks each up once. Results are
// saved as soon as the lookups end, so a later run never looks up the same IP again for 30 days (and a scheduled run that
// finds another run still going skips, so two runs never look up at once). The free plan allows 1,000
// lookups a day (reset at midnight UTC), shared by all of that day's runs: a run takes whatever today's
// earlier runs left, and stops early on HTTP 429 or when the remaining allowance reaches 0; the rest wait
// for the next run. An IP still unchecked once its newest day is more than 3 days old leaves the queue and
// stays counted as a person ("dropped as safe").
// Results are saved under reputation/dt=<day>/ (Glue table ip_reputation, kept 180 days), and each run's
// counts under abuseipdb/runs/dt=<day>/ for the /abuse-check page (kept 120 days). The key lives in SSM;
// without it that step is skipped.
// Nothing about a day changes after the last run on its 3rd day after, so the log merge (compact.js) can then drop its bots.

const net = require('net');
const { runQuery } = require('./athena');
const { EXCLUDED, cleanName, loadHosting, validAsn } = require('./hosting');
const { isoDay, settings } = require('./queries');
const state = require('./bot-state');
const { listKeys, readObject } = require('./logfile');

const API = 'https://api.abuseipdb.com/api/v2/check';
const BOTS_PREFIX = 'bots/';
const STATUS_KEY = 'bots/status.json';
const REPUTATION_PREFIX = 'reputation/';
const DAY_MS = 24 * 60 * 60 * 1000;
// Each run re-judges the last 3 days, so IPs left unchecked when the daily AbuseIPDB limit ran out are
// checked on a later run and their days' verdicts updated.
const DEFAULT_DAYS = 3;
const RUNS_PREFIX = 'abuseipdb/runs/';
const DAILY_LIMIT = 1000;
// Older days' log files have been merged into the archive (compact.js), bots already removed.
const MAX_DAYS = 7;
const REPUTATION_DAYS = 120;
const RECHECK_DAYS = 30;
const MAX_AGE_DAYS = 90;
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

// The days to classify, newest first: today so far (unless `includeToday` is false) and the `days` full
// days before it (UTC).
function daysToClassify(event, now) {
  const requested = event && event.days !== undefined ? Number(event.days) : DEFAULT_DAYS;
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_DAYS) throw new Error(`days must be 1-${MAX_DAYS}`);
  const today = Date.parse(isoDay(now));
  const days = Array.from({ length: requested }, (_, i) => isoDay(today - (i + 1) * DAY_MS));
  return event && event.includeToday === false ? days : [isoDay(today), ...days];
}

// The latest AbuseIPDB result per IP checked since `sinceDay`; used once, to build the reputation cache.
function reputationSql(sinceDay, env = process.env) {
  const { database, reputationTable } = settings(env);
  if (!DAY.test(sinceDay)) throw new Error('Invalid day');
  return `SELECT ip, max_by(score, checked) AS score, max_by(usage_type, checked) AS usage_type,
  max_by(is_tor, checked) AS is_tor, max(checked) AS checked
FROM "${database}"."${reputationTable}"
WHERE dt >= '${sinceDay}'
GROUP BY ip`;
}

// Per day and IP, the counts the rules need, from log files no earlier run has read (bot-state.js); and the
// latest AbuseIPDB result per IP. `save` keeps both for the next run.
async function loadFeatures(days, now, env, bucket, client, deps) {
  const since = new Date(now - REPUTATION_DAYS * DAY_MS).toISOString().slice(0, 19) + 'Z';
  const { states, read } = await state.refresh(client, bucket, days, settings(env).sites, { probe: new RegExp(PROBE), pageFile: new RegExp(PAGE_FILE) });
  let reputation = await state.readReputation(client, bucket, since);
  const rebuilt = !reputation;
  if (rebuilt) {
    const rows = await (deps.runQuery || runQuery)(reputationSql(isoDay(Date.parse(since)), env), { maxRows: MAX_ROWS, deadlineMs: QUERY_DEADLINE_MS });
    reputation = new Map(rows.filter((r) => r.checked >= since).map((r) => [r.ip, r]));
  }
  return {
    rows: state.featureRows(states),
    reputation,
    read,
    saveReputation: () => state.saveReputation(client, bucket, reputation, since),
    save: async () => {
      await state.save(client, bucket, states);
      if (rebuilt) await state.saveReputation(client, bucket, reputation, since);
    },
  };
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
  const header = response.headers && response.headers.get ? response.headers.get('x-ratelimit-remaining') : null;
  const remaining = header !== null && /^\d{1,7}$/.test(header) ? Number(header) : null;
  return { body: JSON.parse(text), lastAllowed: remaining === 0, remaining };
}

// Looks up IPs one after another on a few workers; stops at the daily limit or after repeated failures.
async function checkAll(ips, key, fetchImpl, checked) {
  const results = [];
  let next = 0;
  let failures = 0;
  let stopped = null;
  let remaining = null;
  const worker = async () => {
    while (!stopped && next < ips.length) {
      const ip = ips[next++];
      try {
        const answer = await check(ip, key, fetchImpl);
        results.push(toResult(ip, answer.body, checked));
        if (answer.remaining !== null) remaining = remaining === null ? answer.remaining : Math.min(remaining, answer.remaining);
        if (answer.lastAllowed) stopped = 'daily limit reached';
      } catch (error) {
        if (error instanceof RateLimited) {
          stopped = 'daily limit reached';
          remaining = 0;
        } else if (++failures >= MAX_FAILURES) stopped = `too many failures (last: ${error.message})`;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { results, failures, stopped, remaining };
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

async function putJson(client, bucket, key, value) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(value), ContentType: 'application/json' }));
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

// A run longer than the classifier's 15-minute timeout has died, so another may start.
const RUN_STALE_MS = 16 * 60 * 1000;
const isRunning = (status, now) => Boolean(status && status.state === 'running' && now - Date.parse(status.started) < RUN_STALE_MS);

// AbuseIPDB lookups today's earlier runs used (failed requests included, to be safe), and what is left.
async function allowanceLeft(client, bucket, now) {
  const keys = (await listKeys(client, bucket, `${RUNS_PREFIX}dt=${isoDay(now)}/`)).filter((key) => key.endsWith('.json'));
  let used = 0;
  let left = DAILY_LIMIT;
  for (const key of keys) {
    const run = JSON.parse((await readObject(client, bucket, key)).toString('utf8'));
    used += (Number(run.looked_up) || 0) + (Number(run.failures) || 0);
    if (run.limit_hit === true) left = 0;
    if (Number.isInteger(run.remaining)) left = Math.min(left, run.remaining);
  }
  return Math.max(0, Math.min(left, DAILY_LIMIT - used));
}

async function update(event = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now ?? Date.now();
  const bucket = deps.bucket || env.BOTS_BUCKET;
  if (!bucket) throw new Error('BOTS_BUCKET is not set');
  const days = daysToClassify(event, now);
  const client = deps.s3 || s3();
  const trigger = event && event.trigger === 'dashboard' ? 'dashboard' : 'schedule';
  // The dashboard refuses to start a run while one is going; a scheduled run skips instead.
  if (trigger === 'schedule' && isRunning(await readStatus(client, bucket), now)) {
    const skipped = { skipped: 'another bot check is still running' };
    console.log(JSON.stringify({ message: 'Bot classification skipped', ...skipped }));
    return skipped;
  }
  const started = new Date(now).toISOString();
  await writeStatus(client, bucket, { state: 'running', trigger, started });
  try {
    const summary = await classify(days, now, env, bucket, client, { ...deps, trigger, started });
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
  const features = await (deps.loadFeatures || loadFeatures)(days, now, env, bucket, client, deps);
  const rows = features.rows.filter((row) => validIp(row.ip) && days.includes(row.dt));
  const { reputation } = features;

  // AbuseIPDB: IPs still counted as people (using a browser user agent) without a recent result, newest day first.
  const checked = new Date(now).toISOString().slice(0, 19) + 'Z';
  const recheck = new Date(now - RECHECK_DAYS * DAY_MS).toISOString().slice(0, 19) + 'Z';
  const key = await apiKey(deps.ssm || ssm(), env);
  const abuse = { checked: 0, failures: 0, stopped: key ? null : 'no API key' };
  // Per log day, for the /abuse-check page. Each IP counts once, on its newest day in this run:
  //   seen     - IPs with requests that day (counted on every day they appear)
  //   people   - IPs that use a browser and are not already judged bots by the other rules
  //   skipped  - of those, IPs with an AbuseIPDB result from the last 30 days (not looked up again)
  //   queued   - IPs to look up; looked_up of them were looked up this run, left were not
  //   abusive  - looked up this run and judged abusive
  const perDay = Object.fromEntries(days.map((day) => [day, { seen: 0, people: 0, skipped: 0, queued: 0, looked_up: 0, left: 0, abusive: 0 }]));
  for (const row of rows) perDay[row.dt].seen++;
  const ordered = [...rows].sort((a, b) => b.dt.localeCompare(a.dt) || Number(b.requests) - Number(a.requests));
  const newestDay = new Map();
  const newestAsn = new Map();
  const queue = [];
  for (const row of ordered) {
    if (newestDay.has(row.ip)) continue;
    newestDay.set(row.ip, row.dt);
    newestAsn.set(row.ip, row.asn != null ? validAsn(row.asn) : null);
    if (Number(row.browser_requests) === 0 || verdict(row, networks, reputation.get(row.ip))) continue;
    perDay[row.dt].people++;
    const last = reputation.get(row.ip);
    if (last && last.checked >= recheck) perDay[row.dt].skipped++;
    else {
      perDay[row.dt].queued++;
      queue.push(row.ip);
    }
  }
  const allowance = key ? await allowanceLeft(client, bucket, now) : 0;
  const wanted = queue.slice(0, allowance);
  let lookups = { results: [], failures: 0, stopped: key ? (allowance ? null : 'daily limit reached') : abuse.stopped, remaining: key && !allowance ? 0 : null };
  if (key) {
    const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
    if (allowance) lookups = await checkAll(wanted, key, fetchImpl, checked);
    if (lookups.results.length) await put(client, bucket, `${REPUTATION_PREFIX}dt=${isoDay(now)}/${checked.replace(/[-:]/g, '')}.json`, lookups.results);
    for (const result of lookups.results) reputation.set(result.ip, result);
    // Saved at once, so no later run looks these IPs up again even if this one fails further on.
    if (lookups.results.length) await features.saveReputation();
    Object.assign(abuse, { wanted: queue.length, checked: lookups.results.length, left: queue.length - lookups.results.length, failures: lookups.failures, stopped: lookups.stopped });
  }
  for (const result of lookups.results) {
    const counts = perDay[newestDay.get(result.ip)];
    counts.looked_up++;
    if (isAbusive(result, newestAsn.get(result.ip))) counts.abusive++;
  }
  for (const counts of Object.values(perDay)) counts.left = counts.queued - counts.looked_up;
  const history = {
    version: 1,
    trigger: deps.trigger || 'schedule',
    started: deps.started || new Date(now).toISOString(),
    finished: new Date(deps.now ?? Date.now()).toISOString(),
    from: days[days.length - 1],
    to: days[0],
    limit: DAILY_LIMIT,
    looked_up: lookups.results.length,
    limit_hit: lookups.stopped === 'daily limit reached',
    remaining: lookups.remaining,
    failures: lookups.failures,
    stopped: lookups.stopped,
    days: perDay,
  };
  await putJson(client, bucket, `${RUNS_PREFIX}dt=${isoDay(now)}/${history.started.replace(/[-:.]/g, '')}.json`, history);

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
  // Last, so a run that fails earlier reads its new log files again next time.
  await features.save();
  const summary = { from: days[days.length - 1], to: days[0], days: byDay.size, ips: rows.length, files_read: features.read, bots: counts, abuseipdb: abuse };
  console.log(JSON.stringify({ message: 'Bot classification finished', ...summary }));
  return summary;
}

module.exports = { REPUTATION_CACHE_KEY: state.REPUTATION_CACHE_KEY, STATUS_KEY, RUNS_PREFIX, DAILY_LIMIT, DEFAULT_DAYS, RUN_STALE_MS, isRunning, readStatus, ABUSE_SCORE, DATA_CENTER, PAGE_FILE, PROBE, RateLimited, apiKey, check, daysToClassify, isAbusive, loadFeatures, reputationSql, toResult, update, validIp, verdict };
