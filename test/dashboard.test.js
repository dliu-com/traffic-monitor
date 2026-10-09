const { BadRequest, ipQueries, listQuery, overviewQueries, parseFilters } = require('../lambda/dashboard/queries');
const { createHandler } = require('../lambda/dashboard');
const auth = require('../lambda/dashboard/auth');

const env = { SITES: 'root=dliu.com,cyy=cyy.dliu.com,xiangqi=xiangqi.dliu.com', GLUE_DATABASE: 'traffic', GLUE_TABLE: 'cloudfront_logs', ROOT_DOMAIN: 'dliu.com' };
const NOW = Date.UTC(2026, 9, 9, 12, 30, 0);

describe('filters', () => {
  test('defaults to 7 days across all sites', () => {
    expect(parseFilters({}, NOW, env)).toEqual({ site: 'all', startDay: '2026-10-03', endDay: '2026-10-09', since: null, until: null, unit: 'day' });
  });

  test('24h uses an hourly timestamp filter', () => {
    expect(parseFilters({ range: '24h', site: 'cyy' }, NOW, env))
      .toEqual({ site: 'cyy', startDay: '2026-10-08', endDay: '2026-10-09', since: '2026-10-08 12:30:00', until: null, unit: 'hour' });
  });

  test('1 and 12 hour ranges', () => {
    expect(parseFilters({ range: '1h' }, NOW, env)).toMatchObject({ startDay: '2026-10-09', since: '2026-10-09 11:30:00', unit: 'minute' });
    expect(parseFilters({ range: '12h' }, NOW, env)).toMatchObject({ since: '2026-10-09 00:30:00', unit: 'hour' });
  });

  test('custom ranges with times', () => {
    expect(parseFilters({ from: '2026-10-07T22:15Z', to: '2026-10-08T01:00:00Z' }, NOW, env))
      .toEqual({ site: 'all', startDay: '2026-10-07', endDay: '2026-10-08', since: '2026-10-07 22:15:00', until: '2026-10-08 01:00:00', unit: 'minute' });
    expect(parseFilters({ from: '2026-10-01T00:00Z', to: '2026-10-02T00:00Z' }, NOW, env)).toMatchObject({ endDay: '2026-10-01', unit: 'hour' });
    for (const bad of [{ from: '2026-10-08T01:00Z', to: '2026-10-08T01:00Z' }, { from: '2024-01-01T00:00Z', to: '2026-01-01T00:00Z' },
      { from: "2026-10-08T01:00Z'", to: '2026-10-09T01:00Z' }, { from: '2026-10-08 01:00', to: '2026-10-09T01:00Z' }]) {
      expect(() => parseFilters(bad, NOW, env)).toThrow(BadRequest);
    }
    const sql = overviewQueries(parseFilters({ from: '2026-10-07T22:15Z', to: '2026-10-08T01:00Z' }, NOW, env), env).timeseries;
    expect(sql).toContain("WHERE ts >= from_iso8601_timestamp('2026-10-07T22:15:00Z') AND ts < from_iso8601_timestamp('2026-10-08T01:00:00Z')");
    expect(sql).toContain("date_trunc('minute', ts)");
  });

  test('custom ranges', () => {
    expect(parseFilters({ from: '2026-09-01', to: '2026-09-30' }, NOW, env).startDay).toBe('2026-09-01');
    expect(() => parseFilters({ from: '2026-09-30', to: '2026-09-01' }, NOW, env)).toThrow(BadRequest);
    expect(() => parseFilters({ from: '2024-01-01', to: '2026-01-01' }, NOW, env)).toThrow(BadRequest);
  });

  test.each([
    [{ site: "cyy' OR 1=1 --" }],
    [{ site: 'unknown' }],
    [{ range: '1y' }],
    [{ range: '__proto__' }],
    [{ range: 'toString' }],
    [{ from: "2026-01-01'", to: '2026-01-02' }],
  ])('rejects %j', (query) => {
    expect(() => parseFilters(query, NOW, env)).toThrow(BadRequest);
  });
});

describe('sql', () => {
  const filters = parseFilters({ site: 'cyy', range: '24h' }, NOW, env);

  test('overview queries filter partitions and time', () => {
    const queries = overviewQueries(filters, env);
    expect(Object.keys(queries)).toEqual(['summary', 'timeseries', 'sites', 'site_series']);
    for (const sql of Object.values(queries)) {
      expect(sql).toContain(`FROM "traffic"."cloudfront_logs"`);
      expect(sql).toContain(`dt BETWEEN '2026-10-08' AND '2026-10-09'`);
      expect(sql).toContain(`AND site = 'cyy'`);
      expect(sql).toContain(`WHERE ts >= from_iso8601_timestamp('2026-10-08T12:30:00Z')`);
    }
    expect(queries.timeseries).toContain("date_trunc('hour', ts)");
    expect(queries.site_series).toMatch(/GROUP BY 1, 2/);
    expect(queries.sites).toContain('AS last_visit');
  });

  test('ip queries cover every site and validate the IP', () => {
    const queries = ipQueries(filters, '203.0.113.7', env);
    expect(Object.keys(queries)).toEqual(['summary', 'sites']);
    for (const sql of Object.values(queries)) {
      expect(sql).toContain("ip = '203.0.113.7'");
      expect(sql).not.toContain("AND site = 'cyy'");
    }
    for (const bad of [undefined, '', "1.1.1.1' OR '1'='1", '1.1.1.1;--', '<script>']) {
      expect(() => ipQueries(filters, bad, env)).toThrow(BadRequest);
    }
  });

  test('lists return one page with a total', () => {
    const { sql, limit, offset } = listQuery(filters, { list: 'ips', bots: 'hide', limit: '15', offset: '30' }, env);
    expect([limit, offset]).toEqual([15, 30]);
    expect(sql).toContain('count(*) OVER () AS total');
    expect(sql).toContain("AND site = 'cyy'");
    expect(sql).toMatch(/WHERE NOT is_bot\nORDER BY last_seen DESC, ip\nOFFSET 30 LIMIT 15$/);
    expect(listQuery(filters, { list: 'pages', limit: '5000', offset: '-4' }, env)).toMatchObject({ limit: 100, offset: 0 });
    expect(listQuery(filters, { list: 'referrers' }, env).sql).toContain("'(^|\\.)dliu\\.com$'");
  });

  test('list search becomes safe strpos conditions', () => {
    const { sql } = listQuery(filters, { list: 'requests', q: '  Safari  /Weiqi/ 404 ' }, env);
    expect(sql).toContain("strpos(lower(concat_ws(' ', coalesce(cast(site AS varchar), ''),");
    for (const word of ['safari', '/weiqi/', '404']) expect(sql).toContain(`, '${word}') > 0`);
    for (const bad of ["x' OR 1=1 --", 'a;b', 'a"b', 'a\\b', 'x'.repeat(101)]) {
      expect(() => listQuery(filters, { list: 'requests', q: bad }, env)).toThrow(BadRequest);
    }
    expect(() => listQuery(filters, { list: 'requests', q: '围棋 /path?a=1&b=2' }, env)).not.toThrow();
  });

  test('ip lists ignore the site filter and need a valid IP', () => {
    for (const list of ['related', 'cookies']) {
      const { sql } = listQuery(filters, { list, ip: '2001:db8::1' }, env);
      expect(sql).toContain("ip = '2001:db8::1'");
      expect(sql).not.toContain("AND site = 'cyy'");
      expect(() => listQuery(filters, { list }, env)).toThrow(BadRequest);
    }
    expect(listQuery(filters, { list: 'related', ip: '2001:db8::1' }, env).sql)
      .toContain("NOT ip = '2001:db8::1' AND visitor_id IN (SELECT visitor_id FROM v WHERE ip = '2001:db8::1'");
  });

  test('requests list validates drill-down inputs', () => {
    expect(listQuery(filters, { list: 'requests', visitor: 'abc123def456', bots: 'hide' }, env).sql)
      .toContain("WHERE visitor_id = 'abc123def456' AND NOT is_bot");
    expect(listQuery(filters, { list: 'requests', ip: '2001:db8::1' }, env).sql).toContain("ip = '2001:db8::1'");
    expect(() => listQuery(filters, { list: 'requests', visitor: "x' OR '1'='1" }, env)).toThrow(BadRequest);
    expect(() => listQuery(filters, { list: 'requests', ip: "1.1.1.1'--" }, env)).toThrow(BadRequest);
    for (const list of [undefined, 'nope', '__proto__', 'constructor']) {
      expect(() => listQuery(filters, { list }, env)).toThrow(BadRequest);
    }
  });
});

describe('handler', () => {
  const config = { tenantId: 't', clientId: 'c', clientSecret: 's', allowedDomain: 'example.com' };
  const session = auth.sign({ user: 'user@example.com', exp: Math.floor(NOW / 1000) + 600 }, auth.sessionKey(config));
  const queries = [];
  const handler = createHandler({
    loadConfig: async () => config,
    runQuery: async (sql) => { queries.push(sql); return [{ n: '1' }]; },
    now: () => NOW,
  });
  const request = (path, extra = {}) => handler({ rawPath: path, requestContext: { http: { method: 'GET' } }, ...extra });
  const signedIn = { cookies: [`${auth.SESSION_COOKIE}=${session}`] };

  beforeAll(() => {
    Object.assign(process.env, env, { SITE_URL: 'https://traffic.dliu.com' });
  });

  test('missing sign-in settings return 503, not 500', async () => {
    const { NotConfigured } = require('../lambda/dashboard/config');
    const unconfigured = createHandler({ loadConfig: async () => { throw new NotConfigured('missing'); }, now: () => NOW });
    const call = (path) => unconfigured({ rawPath: path, requestContext: { http: { method: 'GET' } } });
    const api = await call('/api/me');
    expect(api.statusCode).toBe(503);
    expect(JSON.parse(api.body).error).toMatch(/make set-secrets/);
    expect((await call('/auth/login')).statusCode).toBe(503);
  });

  test('api requires a session', async () => {
    expect((await request('/api/overview')).statusCode).toBe(401);
    expect((await request('/api/me', { cookies: [`${auth.SESSION_COOKIE}=forged.value`] })).statusCode).toBe(401);
  });

  test('me returns the user and sites', async () => {
    const response = await request('/api/me', signedIn);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ user: 'user@example.com', sites: { root: 'dliu.com', cyy: 'cyy.dliu.com', xiangqi: 'xiangqi.dliu.com' } });
  });

  test('overview runs all queries', async () => {
    queries.length = 0;
    const response = await request('/api/overview', { ...signedIn, queryStringParameters: { range: '30d' } });
    expect(response.statusCode).toBe(200);
    expect(queries).toHaveLength(4);
    expect(JSON.parse(response.body).summary).toEqual([{ n: '1' }]);
  });

  test('ip view runs its queries across all sites', async () => {
    queries.length = 0;
    const response = await request('/api/ip', { ...signedIn, queryStringParameters: { ip: '2001:db8::1', site: 'cyy', range: '7d' } });
    expect(response.statusCode).toBe(200);
    expect(queries).toHaveLength(2);
    expect(JSON.parse(response.body).filters.site).toBe('all');
    expect((await request('/api/ip', { ...signedIn, queryStringParameters: { ip: "x'" } })).statusCode).toBe(400);
  });

  test('part runs a single query', async () => {
    queries.length = 0;
    const response = await request('/api/overview', { ...signedIn, queryStringParameters: { range: '1h', part: 'timeseries' } });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("date_trunc('minute', ts)");
    expect(JSON.parse(response.body)).toMatchObject({ filters: { unit: 'minute' }, rows: [{ n: '1' }] });
    for (const part of ['nope', '__proto__', 'constructor', '']) {
      expect((await request('/api/overview', { ...signedIn, queryStringParameters: { part } })).statusCode).toBe(400);
    }
    expect((await request('/api/ip', { ...signedIn, queryStringParameters: { ip: '192.0.2.1', part: 'sites' } })).statusCode).toBe(200);
  });

  test('list returns rows without the total column', async () => {
    const paged = createHandler({
      loadConfig: async () => config,
      runQuery: async () => [{ ip: '1.2.3.4', total: '42' }, { ip: '5.6.7.8', total: '42' }],
      now: () => NOW,
    });
    const response = await paged({ rawPath: '/api/list', requestContext: { http: { method: 'GET' } }, ...signedIn, queryStringParameters: { list: 'ips', limit: '2', offset: '4' } });
    expect(JSON.parse(response.body)).toMatchObject({ total: 42, limit: 2, offset: 4, rows: [{ ip: '1.2.3.4' }, { ip: '5.6.7.8' }] });
    expect(JSON.parse(response.body).rows[0]).not.toHaveProperty('total');
    expect((await request('/api/requests', signedIn)).statusCode).toBe(404);
  });

  test('bad input is a 400', async () => {
    const response = await request('/api/list', { ...signedIn, queryStringParameters: { list: 'ips', site: 'nope' } });
    expect(response.statusCode).toBe(400);
  });

  test('login redirects to Microsoft and logout clears cookies', async () => {
    const login = await request('/auth/login');
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toMatch(/^https:\/\/login\.microsoftonline\.com\/t\/oauth2\/v2\.0\/authorize\?/);
    const logout = await request('/auth/logout');
    expect(logout.cookies.every((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  test('only GET is allowed and unknown paths 404', async () => {
    expect((await handler({ rawPath: '/api/me', requestContext: { http: { method: 'POST' } } })).statusCode).toBe(405);
    expect((await request('/api/unknown', signedIn)).statusCode).toBe(404);
  });
});
