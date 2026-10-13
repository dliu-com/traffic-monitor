'use strict';

// Public statistics: a scheduled job (handler `public-stats.update`) writes the figures the public
// dashboard shows to static files (stats/<range>.json in the dashboard bucket). Visitors who are not
// signed in only ever read those files, so they can never start an Athena query.
// The files hold totals only, per site, country and hour/day. No IPs, visitor IDs, pages, referrers,
// user agents, cities or networks.
const { runQuery } = require('./athena');
const { base, isoDay, settings } = require('./queries');

const DAY_MS = 24 * 60 * 60 * 1000;
// Whole UTC days up to yesterday: the files are refreshed once a day, after the bot check.
// (Athena is paid per log file read, so a daily refresh keeps this to cents a month.)
const RANGES = {
  '7d': (now) => ({ startDay: isoDay(now - 7 * DAY_MS), endDay: isoDay(now - DAY_MS), since: null, until: null, unit: 'day', now }),
  '30d': (now) => ({ startDay: isoDay(now - 30 * DAY_MS), endDay: isoDay(now - DAY_MS), since: null, until: null, unit: 'day', now }),
  '90d': (now) => ({ startDay: isoDay(now - 90 * DAY_MS), endDay: isoDay(now - DAY_MS), since: null, until: null, unit: 'day', now }),
};
const METRICS = ['requests', 'pageviews', 'visitors', 'ips', 'errors', 'last_visit'];
// Each row: the site, country and bucket it covers (null = all of them), the metrics with bots
// included, then the same metrics for people only (h_).
const COLUMNS = ['site', 'country', 'bucket', ...METRICS, ...METRICS.map((m) => `h_${m}`)];
const TEXT = new Set(['site', 'country', 'bucket', 'last_visit', 'h_last_visit']);
const MAX_ROWS = 100000;

const TS = (expr) => `date_format(${expr}, '%Y-%m-%dT%H:%i:%sZ')`;

function metrics(humans) {
  const and = humans ? ' AND NOT is_bot' : '';
  const when = (condition) => `CASE WHEN ${condition}${and} THEN`;
  const p = humans ? 'h_' : '';
  return [
    `count(${when('true')} 1 END) AS ${p}requests`,
    `count(${when('is_page')} 1 END) AS ${p}pageviews`,
    `count(DISTINCT ${when('true')} visitor END) AS ${p}visitors`,
    `count(DISTINCT ${when('true')} ip END) AS ${p}ips`,
    `count(${when('status >= 400')} 1 END) AS ${p}errors`,
    `${TS(`max(${when('is_page')} ts END)`)} AS ${p}last_visit`,
  ];
}

// One query per range. GROUPING SETS give every combination of site / country / time bucket the
// public pages ask for, with and without bots, in a single pass over the logs.
function statsQuery(window, env = process.env) {
  const filters = { site: 'all', country: null, bots: 'include', ...window };
  const unit = filters.unit === 'hour' ? 'hour' : 'day';
  return `${base(filters, env)}, g AS (
    SELECT site, coalesce(country, 'unknown') AS cc, ${TS(`date_trunc('${unit}', ts)`)} AS bucket, ts, visitor, ip, status, is_page, is_bot
    FROM v
  )
SELECT site, cc AS country, bucket,
  ${[...metrics(false), ...metrics(true)].join(',\n  ')}
FROM g
GROUP BY GROUPING SETS ((site, cc, bucket), (site, bucket), (cc, bucket), (bucket), (site, cc), (site), (cc), ())`;
}

// Athena rows -> the public file. Only the listed columns are copied, so nothing else can leak.
// Last-visit times are kept only on whole-period rows (the site cards), not per hour or day.
function toFile(range, window, rows, now, env = process.env) {
  const cell = (row, column) => {
    const value = row[column];
    if (column.endsWith('last_visit') && row.bucket != null) return null;
    if (TEXT.has(column)) return value == null ? null : String(value);
    return value == null ? 0 : Number(value) || 0;
  };
  return {
    version: 1,
    range,
    generated: new Date(now).toISOString(),
    filters: { range, ...window },
    sites: settings(env).siteHosts,
    columns: COLUMNS,
    rows: rows.map((row) => COLUMNS.map((column) => cell(row, column))),
  };
}

let s3Client;
const s3 = () => {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({});
  }
  return s3Client;
};

async function writeRange(range, deps, now) {
  const window = RANGES[range](now);
  const rows = await (deps.runQuery || runQuery)(statsQuery(window), { maxRows: MAX_ROWS, deadlineMs: 240000 });
  if (rows.length >= MAX_ROWS) throw new Error(`Too many rows for ${range}`);
  const body = JSON.stringify(toFile(range, window, rows, now));
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await (deps.s3 || s3()).send(new PutObjectCommand({
    Bucket: process.env.STATS_BUCKET,
    Key: `stats/${range}.json`,
    Body: body,
    ContentType: 'application/json; charset=utf-8',
    // CloudFront and browsers may keep a copy for 5 minutes.
    CacheControl: 'public, max-age=300',
  }));
  return { range, rows: rows.length, bytes: body.length };
}

// event.ranges picks the files to refresh; default all.
async function update(event = {}, deps = {}) {
  const now = (deps.now || Date.now)();
  const wanted = event && Array.isArray(event.ranges) ? event.ranges : Object.keys(RANGES);
  const ranges = wanted.filter((range) => Object.hasOwn(RANGES, range));
  if (!ranges.length) throw new Error('No known ranges to refresh');
  const results = await Promise.all(ranges.map((range) => writeRange(range, deps, now)));
  console.log(JSON.stringify({ message: 'Public statistics updated', results }));
  return results;
}

module.exports = { COLUMNS, RANGES, statsQuery, toFile, update };
