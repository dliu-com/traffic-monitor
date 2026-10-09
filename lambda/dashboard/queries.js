'use strict';

// All user input is validated against strict allowlists/patterns before it is placed in SQL.
const DAY_MS = 24 * 60 * 60 * 1000;
const RANGES = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VISITOR_ID = /^[a-z0-9]{8,40}$/;
const IP = /^[0-9a-fA-F:.]{2,45}$/;
const IDENTIFIER = /^[a-z0-9_]+$/;

const ASSET = '\\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|json|txt|xml|webmanifest|wasm)$';
const BOT = 'bot|crawl|spider|slurp|curl|wget|python|httpclient|http-client|headless|monitor|preview|scanner|go-http|java/|okhttp|axios|node-fetch|facebookexternalhit|lighthouse';

class BadRequest extends Error {}

function settings(env = process.env) {
  const database = env.GLUE_DATABASE || 'traffic';
  const table = env.GLUE_TABLE || 'cloudfront_logs';
  if (!IDENTIFIER.test(database) || !IDENTIFIER.test(table)) throw new Error('Invalid Glue identifiers');
  const siteHosts = {};
  for (const entry of String(env.SITES || '').split(',')) {
    const [key, host] = entry.split('=').map((s) => s.trim());
    if (key) siteHosts[key] = host || key;
  }
  return { database, table, sites: Object.keys(siteHosts), siteHosts, rootDomain: env.ROOT_DOMAIN || 'dliu.com' };
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function parseFilters(query = {}, now = Date.now(), env = process.env) {
  const { sites } = settings(env);
  const site = query.site || 'all';
  if (site !== 'all' && !sites.includes(site)) throw new BadRequest('Unknown site');

  if (query.from || query.to) {
    const { from, to } = query;
    if (!DAY.test(from || '') || !DAY.test(to || '')) throw new BadRequest('from/to must be YYYY-MM-DD');
    const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
    if (!(span >= 0 && span <= 366)) throw new BadRequest('Custom range must be 0-366 days');
    return { site, startDay: from, endDay: to, since: null, hourly: span < 2 };
  }

  const range = query.range || '7d';
  if (!Object.hasOwn(RANGES, range)) throw new BadRequest('Unknown range');
  const days = RANGES[range];
  if (range === '24h') {
    const since = new Date(now - DAY_MS).toISOString().slice(0, 19).replace('T', ' ');
    return { site, startDay: isoDay(now - DAY_MS), endDay: isoDay(now), since, hourly: true };
  }
  return { site, startDay: isoDay(now - (days - 1) * DAY_MS), endDay: isoDay(now), since: null, hourly: false };
}

function base(filters, env = process.env) {
  const { database, table } = settings(env);
  const siteFilter = filters.site === 'all' ? '' : `\n      AND site = '${filters.site}'`;
  const sinceFilter = filters.since ? `\n    WHERE ts >= from_iso8601_timestamp('${filters.since.replace(' ', 'T')}Z')` : '';
  return `WITH r AS (
    SELECT site,
      from_iso8601_timestamp(concat(cast("date" AS varchar), 'T', time, 'Z')) AS ts,
      c_ip AS ip,
      cs_method AS method,
      x_host_header AS host,
      url_decode(cs_uri_stem) AS path,
      sc_status AS status,
      nullif(url_decode(cs_referrer), '-') AS referrer,
      url_decode(cs_user_agent) AS ua,
      regexp_extract(url_decode(cs_cookie), 'dl_vid=([a-z0-9]+)', 1) AS visitor_id,
      x_edge_result_type AS result,
      sc_bytes AS bytes
    FROM "${database}"."${table}"
    WHERE dt BETWEEN '${filters.startDay}' AND '${filters.endDay}'${siteFilter}
  ), v AS (
    SELECT *,
      coalesce(visitor_id, concat('ip:', ip)) AS visitor,
      regexp_like(lower(coalesce(ua, '')), '${BOT}') AS is_bot,
      (method = 'GET' AND status < 400 AND NOT regexp_like(lower(path), '${ASSET}') AND NOT starts_with(path, '/api/')) AS is_page
    FROM r${sinceFilter}
  )`;
}

const TS = (expr) => `date_format(${expr}, '%Y-%m-%dT%H:%i:%sZ')`;

function overviewQueries(filters, env = process.env) {
  const { rootDomain } = settings(env);
  const cte = base(filters, env);
  const unit = filters.hourly ? 'hour' : 'day';
  const internal = `(^|\\.)${rootDomain.replace(/[^a-z0-9.-]/gi, '').replace(/\./g, '\\.')}$`;
  return {
    summary: `${cte}
SELECT count(*) AS requests,
  count_if(is_page AND NOT is_bot) AS pageviews,
  count(DISTINCT CASE WHEN NOT is_bot THEN visitor END) AS visitors,
  count(DISTINCT CASE WHEN NOT is_bot THEN visitor_id END) AS cookie_visitors,
  count(DISTINCT ip) AS ips,
  count_if(is_bot) AS bot_requests,
  count_if(status >= 400) AS errors,
  coalesce(sum(bytes), 0) AS bytes
FROM v`,
    timeseries: `${cte}
SELECT ${TS(`date_trunc('${unit}', ts)`)} AS bucket,
  count(*) AS requests,
  count_if(is_page AND NOT is_bot) AS pageviews,
  count(DISTINCT CASE WHEN NOT is_bot THEN visitor END) AS visitors
FROM v GROUP BY 1 ORDER BY 1`,
    sites: `${cte}
SELECT site, count(*) AS requests,
  count_if(is_page AND NOT is_bot) AS pageviews,
  count(DISTINCT CASE WHEN NOT is_bot THEN visitor END) AS visitors
FROM v GROUP BY site ORDER BY requests DESC`,
    pages: `${cte}
SELECT site, path, count(*) AS views, count(DISTINCT visitor) AS visitors
FROM v WHERE is_page AND NOT is_bot
GROUP BY site, path ORDER BY views DESC LIMIT 25`,
    referrers: `${cte}
SELECT url_extract_host(referrer) AS referrer, count(*) AS views, count(DISTINCT visitor) AS visitors
FROM v WHERE is_page AND NOT is_bot AND referrer IS NOT NULL
  AND NOT regexp_like(coalesce(url_extract_host(referrer), ''), '${internal}')
GROUP BY 1 ORDER BY views DESC LIMIT 25`,
    visitors: `${cte}
SELECT visitor, max(visitor_id) AS visitor_id, ${TS('min(ts)')} AS first_seen, ${TS('max(ts)')} AS last_seen,
  count(*) AS requests, count_if(is_page) AS pageviews,
  array_join(array_sort(array_agg(DISTINCT site)), ',') AS sites,
  count(DISTINCT ip) AS ips, max_by(ip, ts) AS last_ip, max_by(ua, ts) AS last_ua
FROM v WHERE NOT is_bot
GROUP BY visitor ORDER BY max(ts) DESC LIMIT 50`,
  };
}

function requestsQuery(filters, query = {}, env = process.env) {
  const conditions = [];
  if (query.visitor) {
    if (!VISITOR_ID.test(query.visitor)) throw new BadRequest('Invalid visitor id');
    conditions.push(`visitor_id = '${query.visitor}'`);
  }
  if (query.ip) {
    if (!IP.test(query.ip)) throw new BadRequest('Invalid IP');
    conditions.push(`ip = '${query.ip}'`);
  }
  if (query.bots === 'hide') conditions.push('NOT is_bot');
  if (query.pages === 'only') conditions.push('is_page');
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 200, 1), 1000);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return `${base(filters, env)}
SELECT ${TS('ts')} AS time, site, ip, visitor_id, method, host, path, status, referrer, ua, result, is_bot, is_page
FROM v ${where}
ORDER BY ts DESC LIMIT ${limit}`;
}

module.exports = { BadRequest, base, overviewQueries, parseFilters, requestsQuery, settings };
