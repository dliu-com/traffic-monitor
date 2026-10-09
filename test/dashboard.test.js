const { BadRequest, ipQueries, overviewQueries, parseFilters, requestsQuery } = require('../lambda/dashboard/queries');
const { createHandler } = require('../lambda/dashboard');
const auth = require('../lambda/dashboard/auth');

const env = { SITES: 'root=dliu.com,cyy=cyy.dliu.com,xiangqi=xiangqi.dliu.com', GLUE_DATABASE: 'traffic', GLUE_TABLE: 'cloudfront_logs', ROOT_DOMAIN: 'dliu.com' };
const NOW = Date.UTC(2026, 9, 9, 12, 30, 0);

describe('filters', () => {
  test('defaults to 7 days across all sites', () => {
    expect(parseFilters({}, NOW, env)).toEqual({ site: 'all', startDay: '2026-10-03', endDay: '2026-10-09', since: null, hourly: false });
  });

  test('24h uses an hourly timestamp filter', () => {
    expect(parseFilters({ range: '24h', site: 'cyy' }, NOW, env))
      .toEqual({ site: 'cyy', startDay: '2026-10-08', endDay: '2026-10-09', since: '2026-10-08 12:30:00', hourly: true });
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
    expect(Object.keys(queries)).toEqual(['summary', 'timeseries', 'sites', 'site_series', 'pages', 'referrers', 'ips']);
    for (const sql of Object.values(queries)) {
      expect(sql).toContain(`FROM "traffic"."cloudfront_logs"`);
      expect(sql).toContain(`dt BETWEEN '2026-10-08' AND '2026-10-09'`);
      expect(sql).toContain(`AND site = 'cyy'`);
      expect(sql).toContain(`WHERE ts >= from_iso8601_timestamp('2026-10-08T12:30:00Z')`);
    }
    expect(queries.timeseries).toContain("date_trunc('hour', ts)");
    expect(queries.referrers).toContain("'(^|\\.)dliu\\.com$'");
    expect(queries.site_series).toMatch(/GROUP BY 1, 2/);
    expect(queries.ips).toMatch(/GROUP BY ip ORDER BY max\(ts\) DESC LIMIT 1000$/);
    expect(queries.sites).toContain('AS last_visit');
  });

  test('ip queries cover every site and validate the IP', () => {
    const queries = ipQueries(filters, '203.0.113.7', env);
    expect(Object.keys(queries)).toEqual(['summary', 'sites', 'related', 'requests']);
    for (const sql of Object.values(queries)) {
      expect(sql).toContain("ip = '203.0.113.7'");
      expect(sql).not.toContain("AND site = 'cyy'");
    }
    expect(queries.related).toContain("NOT ip = '203.0.113.7' AND visitor_id IN (SELECT visitor_id FROM v WHERE ip = '203.0.113.7'");
    for (const bad of [undefined, '', "1.1.1.1' OR '1'='1", '1.1.1.1;--', '<script>']) {
      expect(() => ipQueries(filters, bad, env)).toThrow(BadRequest);
    }
  });

  test('requests query validates drill-down inputs', () => {
    expect(requestsQuery(filters, { visitor: 'abc123def456', bots: 'hide', limit: '5000' }, env))
      .toMatch(/WHERE visitor_id = 'abc123def456' AND NOT is_bot\nORDER BY ts DESC LIMIT 1000$/);
    expect(requestsQuery(filters, { ip: '2001:db8::1' }, env)).toContain("ip = '2001:db8::1'");
    expect(() => requestsQuery(filters, { visitor: "x' OR '1'='1" }, env)).toThrow(BadRequest);
    expect(() => requestsQuery(filters, { ip: "1.1.1.1'--" }, env)).toThrow(BadRequest);
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
    expect(queries).toHaveLength(7);
    expect(JSON.parse(response.body).summary).toEqual([{ n: '1' }]);
  });

  test('ip view runs its queries across all sites', async () => {
    queries.length = 0;
    const response = await request('/api/ip', { ...signedIn, queryStringParameters: { ip: '2001:db8::1', site: 'cyy', range: '7d' } });
    expect(response.statusCode).toBe(200);
    expect(queries).toHaveLength(4);
    expect(JSON.parse(response.body).filters.site).toBe('all');
    expect((await request('/api/ip', { ...signedIn, queryStringParameters: { ip: "x'" } })).statusCode).toBe(400);
  });

  test('bad input is a 400', async () => {
    const response = await request('/api/requests', { ...signedIn, queryStringParameters: { site: 'nope' } });
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
