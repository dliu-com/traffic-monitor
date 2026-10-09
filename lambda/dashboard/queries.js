'use strict';

// All user input is validated against strict allowlists/patterns before it is placed in SQL.
const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_HOURS = { '1h': 1, '12h': 12, '24h': 24, '7d': 7 * 24, '30d': 30 * 24, '90d': 90 * 24, '365d': 365 * 24 };
const MAX_CUSTOM_DAYS = 366;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/;
const VISITOR_ID = /^[a-z0-9]{8,40}$/;
const IP = /^[0-9a-fA-F:.]{2,45}$/;
const IDENTIFIER = /^[a-z0-9_]+$/;
// Two-letter country code, or "unknown" for addresses without a country.
const COUNTRY = /^([A-Z]{2}|unknown)$/;

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
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// Chart buckets: minutes for up to 3 hours, hours for up to 3 days, days beyond that.
const unitFor = (ms) => (ms <= 3 * 3600e3 ? 'minute' : ms <= 3 * DAY_MS ? 'hour' : 'day');

// Returns the site, country, the days to read (log partitions) and an optional exact [since, until) window in UTC.
function parseFilters(query = {}, now = Date.now(), env = process.env) {
  const { sites } = settings(env);
  const site = query.site || 'all';
  if (site !== 'all' && !sites.includes(site)) throw new BadRequest('Unknown site');
  const country = query.country || null;
  if (country !== null && !COUNTRY.test(country)) throw new BadRequest('Unknown country');
  return { site, country, ...timeWindow(query, now) };
}

function timeWindow(query, now) {
  if (query.from || query.to) {
    const { from = '', to = '' } = query;
    if (DAY.test(from) && DAY.test(to)) {
      const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
      if (!(span >= 0 && span <= MAX_CUSTOM_DAYS)) throw new BadRequest(`Custom range must be 0-${MAX_CUSTOM_DAYS} days`);
      return { startDay: from, endDay: to, since: null, until: null, unit: unitFor((span + 1) * DAY_MS) };
    }
    if (!INSTANT.test(from) || !INSTANT.test(to)) throw new BadRequest('from/to must be YYYY-MM-DD or YYYY-MM-DDTHH:MMZ');
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (!(end > start && end - start <= MAX_CUSTOM_DAYS * DAY_MS)) throw new BadRequest(`Custom range must end after it starts and span at most ${MAX_CUSTOM_DAYS} days`);
    return { startDay: isoDay(start), endDay: isoDay(end - 1000), since: sqlTime(start), until: sqlTime(end), unit: unitFor(end - start) };
  }

  const range = query.range || '7d';
  if (!Object.hasOwn(RANGE_HOURS, range)) throw new BadRequest('Unknown range');
  const hours = RANGE_HOURS[range];
  if (hours <= 24) {
    const start = now - hours * 3600e3;
    return { startDay: isoDay(start), endDay: isoDay(now), since: sqlTime(start), until: null, unit: unitFor(hours * 3600e3) };
  }
  return { startDay: isoDay(now - (hours - 24) * 3600e3), endDay: isoDay(now), since: null, until: null, unit: 'day' };
}

// visitor_id is the dl_vid cookie the browser sent. A request without one (a visitor's first) gets the
// ID the visitor function assigned and logged (vid_log), but only if the browser later sent that ID
// back; clients that never keep cookies would otherwise count as a new visitor on every request,
// so they fall back to their IP address instead.
function base(filters, env = process.env) {
  const { database, table } = settings(env);
  const siteFilter = filters.site === 'all' ? '' : `\n      AND site = '${filters.site}'`;
  const countryFilter = !filters.country ? ''
    : filters.country === 'unknown' ? `\n      AND coalesce(c_country, '-') = '-'` : `\n      AND c_country = '${filters.country}'`;
  const window = [];
  if (filters.since) window.push(`ts >= from_iso8601_timestamp('${filters.since.replace(' ', 'T')}Z')`);
  if (filters.until) window.push(`ts < from_iso8601_timestamp('${filters.until.replace(' ', 'T')}Z')`);
  const sinceFilter = window.length ? `\n    WHERE ${window.join(' AND ')}` : '';
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
      regexp_extract(url_decode(cs_cookie), 'dl_vid=([a-z0-9]{8,40})', 1) AS cookie_id,
      regexp_extract(vid_log, '^([a-z0-9]{8,40})$', 1) AS logged_id,
      x_edge_result_type AS result,
      sc_bytes AS bytes,
      nullif(c_country, '-') AS country,
      CASE WHEN regexp_like(asn, '^[0-9]{1,10}$') THEN asn END AS asn
    FROM "${database}"."${table}"
    WHERE dt BETWEEN '${filters.startDay}' AND '${filters.endDay}'${siteFilter}${countryFilter}
  ), w AS (
    SELECT *,
      coalesce(cookie_id, CASE WHEN logged_id IS NOT NULL
        AND bool_or(cookie_id IS NOT NULL) OVER (PARTITION BY coalesce(logged_id, ip)) THEN logged_id END) AS visitor_id
    FROM r${sinceFilter}
  ), v AS (
    SELECT *,
      coalesce(visitor_id, concat('ip:', ip)) AS visitor,
      regexp_like(lower(coalesce(ua, '')), '${BOT}') AS is_bot,
      (method = 'GET' AND status < 400 AND NOT regexp_like(lower(path), '${ASSET}') AND NOT starts_with(path, '/api/')) AS is_page
    FROM w
  )`;
}

const TS = (expr) => `date_format(${expr}, '%Y-%m-%dT%H:%i:%sZ')`;

function overviewQueries(filters, env = process.env) {
  const cte = base(filters, env);
  const unit = ['minute', 'hour', 'day'].includes(filters.unit) ? filters.unit : 'day';
  return {
    summary: `${cte}
SELECT count(*) AS requests,
  count_if(is_page AND NOT is_bot) AS pageviews,
  count(DISTINCT CASE WHEN NOT is_bot THEN visitor END) AS visitors,
  count(DISTINCT CASE WHEN NOT is_bot THEN visitor_id END) AS cookie_visitors,
  count(DISTINCT ip) AS ips,
  count(DISTINCT CASE WHEN NOT is_bot THEN ip END) AS human_ips,
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
  count(DISTINCT CASE WHEN NOT is_bot THEN visitor END) AS visitors,
  count(DISTINCT CASE WHEN NOT is_bot THEN ip END) AS ips,
  ${TS('max(CASE WHEN is_page AND NOT is_bot THEN ts END)')} AS last_visit
FROM v GROUP BY site ORDER BY pageviews DESC, requests DESC`,
    site_series: `${cte}
SELECT site, ${TS(`date_trunc('${unit}', ts)`)} AS bucket,
  count_if(is_page AND NOT is_bot) AS pageviews
FROM v GROUP BY 1, 2 ORDER BY 1, 2`,
  };
}

// Tables are paged on the server: each call returns one page plus the total number of matching rows.
const PAGE_MAX = 100;
const OFFSET_MAX = 100000;
const SEARCH = /^[\p{L}\p{N}\p{M} ._:/@?=&+~,#%()-]{0,100}$/u;

function searchCondition(q, columns) {
  if (!SEARCH.test(q)) throw new BadRequest('Search may only use letters, digits, spaces and . _ : / @ ? = & + ~ , # % ( ) -');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const text = `lower(concat_ws(' ', ${columns.map((c) => `coalesce(cast(${c} AS varchar), '')`).join(', ')}))`;
  return words.map((word) => `strpos(${text}, '${word}') > 0`);
}

function pageNumber(value, fallback, min, max) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function requireIp(ip) {
  if (!IP.test(ip || '')) throw new BadRequest('Invalid IP');
  return `ip = '${ip}'`;
}

const LISTS = {
  ips: (q) => ({
    sql: `SELECT ip, count(*) AS requests, count_if(is_page) AS pageviews,
  array_join(array_sort(array_agg(DISTINCT site)), ',') AS sites,
  ${TS('min(ts)')} AS first_seen, ${TS('max(ts)')} AS last_seen,
  max_by(ua, ts) AS last_ua, bool_and(is_bot) AS is_bot, max_by(country, ts) AS country, max_by(asn, ts) AS asn
FROM v GROUP BY ip`,
    where: q.bots === 'hide' ? ['NOT is_bot'] : [],
    search: ['ip', 'sites', 'last_ua', 'country', 'asn'],
    order: 'last_seen DESC, ip',
  }),
  countries: () => ({
    sql: `SELECT coalesce(country, 'unknown') AS country,
  count(DISTINCT CASE WHEN NOT is_bot THEN visitor END) AS visitors,
  count_if(is_page AND NOT is_bot) AS pageviews,
  count(DISTINCT CASE WHEN NOT is_bot THEN ip END) AS ips,
  count(*) AS requests
FROM v GROUP BY 1`,
    search: ['country'],
    order: 'visitors DESC, requests DESC, country',
  }),
  pages: () => ({
    sql: `SELECT site, path, count(*) AS views, count(DISTINCT visitor) AS visitors
FROM v WHERE is_page AND NOT is_bot GROUP BY site, path`,
    search: ['path'],
    order: 'views DESC, path',
  }),
  referrers: (q, env) => {
    const { rootDomain } = settings(env);
    const internal = `(^|\\.)${rootDomain.replace(/[^a-z0-9.-]/gi, '').replace(/\./g, '\\.')}$`;
    return {
      sql: `SELECT url_extract_host(referrer) AS referrer, count(*) AS views, count(DISTINCT visitor) AS visitors
FROM v WHERE is_page AND NOT is_bot AND referrer IS NOT NULL
  AND NOT regexp_like(coalesce(url_extract_host(referrer), ''), '${internal}')
GROUP BY 1`,
      search: ['referrer'],
      order: 'views DESC, referrer',
    };
  },
  requests: (q) => {
    const conditions = [];
    if (q.visitor) {
      if (!VISITOR_ID.test(q.visitor)) throw new BadRequest('Invalid visitor id');
      conditions.push(`visitor_id = '${q.visitor}'`);
    }
    if (q.ip) conditions.push(requireIp(q.ip));
    if (q.bots === 'hide') conditions.push('NOT is_bot');
    if (q.pages === 'only') conditions.push('is_page');
    return {
      sql: `SELECT ${TS('ts')} AS time, site, ip, country, visitor_id, method, path, status, referrer, ua, result, is_bot, is_page
FROM v${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}`,
      search: ['site', 'ip', 'country', 'method', 'path', 'status', 'referrer', 'ua'],
      order: '"time" DESC, ip, path',
    };
  },
  // Other IPs that used a visitor ID also seen on this IP (likely the same person).
  related: (q) => {
    const match = requireIp(q.ip);
    return {
      allSites: true,
      sql: `SELECT ip, count(*) AS requests, count_if(is_page) AS pageviews,
  array_join(array_sort(array_agg(DISTINCT site)), ',') AS sites,
  ${TS('max(ts)')} AS last_seen, max_by(ua, ts) AS last_ua, max_by(country, ts) AS country
FROM v
WHERE NOT ${match} AND visitor_id IN (SELECT visitor_id FROM v WHERE ${match} AND visitor_id IS NOT NULL)
GROUP BY ip`,
      search: ['ip', 'sites', 'last_ua', 'country'],
      order: 'last_seen DESC, ip',
    };
  },
  cookies: (q) => ({
    allSites: true,
    sql: `SELECT visitor_id, count(*) AS requests, count_if(is_page) AS pageviews,
  array_join(array_sort(array_agg(DISTINCT site)), ',') AS sites,
  ${TS('min(ts)')} AS first_seen, ${TS('max(ts)')} AS last_seen
FROM v WHERE ${requireIp(q.ip)} AND visitor_id IS NOT NULL
GROUP BY visitor_id`,
    search: ['visitor_id', 'sites'],
    order: 'last_seen DESC, visitor_id',
  }),
};

function listQuery(filters, query = {}, env = process.env) {
  if (!Object.hasOwn(LISTS, query.list || '')) throw new BadRequest('Unknown list');
  const list = LISTS[query.list](query, env);
  const limit = pageNumber(query.limit, 20, 1, PAGE_MAX);
  const offset = pageNumber(query.offset, 0, 0, OFFSET_MAX);
  const where = [...(list.where || []), ...searchCondition(query.q || '', list.search)];
  return {
    limit,
    offset,
    sql: `${base(list.allSites ? { ...filters, site: 'all', country: null } : filters, env)}
SELECT *, count(*) OVER () AS total FROM (
${list.sql}
) t${where.length ? `\nWHERE ${where.join(' AND ')}` : ''}
ORDER BY ${list.order}
OFFSET ${offset} LIMIT ${limit}`,
  };
}

// Summary of one IP address across every site; its long lists come from listQuery.
function ipQueries(filters, ip, env = process.env) {
  const match = requireIp(ip);
  const cte = base({ ...filters, site: 'all', country: null }, env);
  return {
    summary: `${cte}
SELECT count(*) AS requests, count_if(is_page) AS pageviews,
  max_by(country, ts) AS country, count(DISTINCT country) AS countries, max_by(asn, ts) AS asn,
  count(DISTINCT site) AS sites, count(DISTINCT date(ts)) AS days,
  ${TS('min(ts)')} AS first_seen, ${TS('max(ts)')} AS last_seen,
  count(DISTINCT visitor_id) AS cookies,
  max_by(ua, ts) AS last_ua, bool_and(is_bot) AS is_bot,
  count(DISTINCT ua) AS user_agents, count_if(status >= 400) AS errors
FROM v WHERE ${match}`,
    sites: `${cte}
SELECT site, count(*) AS requests, count_if(is_page) AS pageviews,
  ${TS('min(ts)')} AS first_seen, ${TS('max(ts)')} AS last_seen
FROM v WHERE ${match}
GROUP BY site ORDER BY max(ts) DESC`,
  };
}

module.exports = { BadRequest, PAGE_MAX, base, ipQueries, listQuery, overviewQueries, parseFilters, settings };
