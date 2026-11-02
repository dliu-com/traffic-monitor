const stats = require('../lambda/dashboard/public-stats');

const NOW = Date.UTC(2026, 9, 13, 19, 30, 0);
const env = { SITES: 'root=dliu.com,cyy=cyy.dliu.com', GLUE_DATABASE: 'traffic', GLUE_TABLE: 'cloudfront_logs' };

beforeEach(() => {
  process.env.SITES = env.SITES;
  process.env.STATS_BUCKET = 'dashboard-bucket';
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('public ranges are 7, 30 and 90 whole days ending yesterday', () => {
  expect(Object.keys(stats.RANGES)).toEqual(['7d', '30d', '90d']);
  expect(stats.RANGES['7d'](NOW)).toEqual({ startDay: '2026-10-06', endDay: '2026-10-12', since: null, until: null, unit: 'day', now: NOW });
  expect(stats.RANGES['30d'](NOW)).toMatchObject({ startDay: '2026-09-13', endDay: '2026-10-12', unit: 'day' });
  expect(stats.RANGES['90d'](NOW)).toMatchObject({ startDay: '2026-07-15', endDay: '2026-10-12', unit: 'day' });
});

test('one query gives every site/country/bucket combination, with and without bots', () => {
  const sql = stats.statsQuery(stats.RANGES['7d'](NOW), env);
  expect(sql).toContain("dt BETWEEN '2026-10-06' AND '2026-10-12'");
  expect(sql).toContain("date_trunc('day', ts)");
  expect(sql).toContain('GROUPING SETS ((site, cc, bucket), (site, bucket), (cc, bucket), (bucket), (site, cc), (site), (cc), ())');
  expect(sql).toContain('count(DISTINCT CASE WHEN true THEN visitor END) AS visitors');
  expect(sql).toContain('count(DISTINCT CASE WHEN true AND NOT is_bot THEN visitor END) AS h_visitors');
  // Bots are kept in the base rows so both variants come from one pass.
  expect(sql).not.toContain('WHERE bot_reason IS NULL');
  expect(stats.statsQuery(stats.RANGES['90d'](NOW), env)).toContain("date_trunc('day', ts)");
});

test('private sites are left out of the query, the totals and the site list', () => {
  const priv = { ...env, SITES: 'root=dliu.com,cyy=cyy.dliu.com,jh=jh.dliu.com', PRIVATE_SITES: 'cyy,jh' };
  const window = stats.RANGES['7d'](NOW);
  expect(stats.statsQuery(window, priv)).toContain("FROM v\n    WHERE site NOT IN ('cyy', 'jh')");
  expect(stats.statsQuery(window, env)).not.toContain('NOT IN');
  const rows = [
    { site: 'root', country: null, bucket: null, requests: '5' },
    { site: 'cyy', country: null, bucket: null, requests: '7' },
  ];
  const file = stats.toFile('7d', window, rows, NOW, priv);
  expect(file.sites).toEqual({ root: 'dliu.com' });
  expect(file.rows.map((r) => r[0])).toEqual(['root']);
  expect(JSON.stringify(file)).not.toMatch(/cyy|jh\./);
  expect(() => stats.statsQuery(window, { ...env, PRIVATE_SITES: "x') OR (1=1" })).toThrow(/PRIVATE_SITES/);
});

test('the public file copies only allowlisted totals', () => {
  const window = stats.RANGES['7d'](NOW);
  const rows = [
    { site: null, country: null, bucket: null, requests: '10', pageviews: '4', visitors: '3', ips: '3', errors: '1', last_visit: '2026-10-13T19:01:01Z', h_requests: '6', h_pageviews: '2', h_visitors: '2', h_ips: '2', h_errors: '0', h_last_visit: '2026-10-13T18:00:00Z', ip: '203.0.113.9', visitor: 'abc12345', path: '/secret', ua: 'curl', city: 'Dublin' },
    { site: 'cyy', country: 'IE', bucket: '2026-10-13T00:00:00Z', requests: '2', pageviews: null, visitors: '1', ips: '1', errors: '0', last_visit: '2026-10-13T10:00:00Z', h_requests: '0', h_pageviews: '0', h_visitors: '0', h_ips: '0', h_errors: '0', h_last_visit: null },
  ];
  const file = stats.toFile('7d', window, rows, NOW, env);
  expect(file).toMatchObject({ version: 1, range: '7d', generated: '2026-10-13T19:30:00.000Z', sites: { root: 'dliu.com', cyy: 'cyy.dliu.com' }, columns: stats.COLUMNS });
  expect(file.rows[0]).toEqual([null, null, null, 10, 4, 3, 3, 1, '2026-10-13T19:01:01Z', 6, 2, 2, 2, 0, '2026-10-13T18:00:00Z']);
  // Per-bucket rows carry no last-visit time; missing numbers become 0.
  expect(file.rows[1]).toEqual(['cyy', 'IE', '2026-10-13T00:00:00Z', 2, 0, 1, 1, 0, null, 0, 0, 0, 0, 0, null]);
  const text = JSON.stringify(file);
  for (const leak of ['203.0.113.9', 'abc12345', '/secret', 'curl', 'Dublin']) expect(text).not.toContain(leak);
});

test('update writes each requested range to stats/<range>.json with a short cache time', async () => {
  const puts = [];
  const queries = [];
  const s3 = { send: async (command) => { puts.push(command.input); return {}; } };
  const runQuery = async (sql, options) => { queries.push({ sql, options }); return [{ site: null, country: null, bucket: null, requests: '1' }]; };
  const results = await stats.update({ ranges: ['24h', 'nope', '7d', '30d'] }, { s3, runQuery, now: () => NOW });
  expect(results.map((r) => r.range)).toEqual(['7d', '30d']);
  expect(puts.map((p) => p.Key).sort()).toEqual(['stats/30d.json', 'stats/7d.json']);
  expect(puts[0]).toMatchObject({ Bucket: 'dashboard-bucket', ContentType: 'application/json; charset=utf-8', CacheControl: 'public, max-age=300, s-maxage=86400' });
  expect(JSON.parse(puts[0].Body).rows).toHaveLength(1);
  expect(queries[0].options.maxRows).toBe(100000);
});

test('update refreshes every range by default and rejects unknown ones', async () => {
  const puts = [];
  const deps = { s3: { send: async (c) => { puts.push(c.input.Key); return {}; } }, runQuery: async () => [], now: () => NOW };
  await stats.update({}, deps);
  expect(puts.sort()).toEqual(['stats/30d.json', 'stats/7d.json', 'stats/90d.json']);
  await expect(stats.update({ ranges: ['1y'] }, deps)).rejects.toThrow('No known ranges');
});

test('update clears /stats/* at CloudFront once, after all files are written', async () => {
  const order = [];
  class CreateInvalidationCommand { constructor(input) { this.input = input; } }
  const deps = {
    s3: { send: async (c) => { order.push(c.input.Key); return {}; } },
    runQuery: async () => [],
    now: () => NOW,
    cloudfrontSdk: { CreateInvalidationCommand },
    cloudfront: { send: async (c) => { order.push(c.input); return {}; } },
  };
  process.env.DISTRIBUTION_ID = 'EXAMPLE';
  try {
    await stats.update({}, deps);
  } finally {
    delete process.env.DISTRIBUTION_ID;
  }
  expect(order).toHaveLength(4);
  expect(order[3]).toEqual({
    DistributionId: 'EXAMPLE',
    InvalidationBatch: { CallerReference: `stats-${NOW}`, Paths: { Quantity: 1, Items: ['/stats/*'] } },
  });
  deps.cloudfront.send = async () => { throw new Error('throttled'); };
  process.env.DISTRIBUTION_ID = 'EXAMPLE';
  try {
    await expect(stats.update({}, deps)).rejects.toThrow('throttled');
  } finally {
    delete process.env.DISTRIBUTION_ID;
  }
});
