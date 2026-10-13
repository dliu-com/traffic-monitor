const { BadRequest, base, botQueries, ipQueries, layout, listQuery, overviewQueries, pageQueries, parseFilters } = require('../lambda/dashboard/queries');
const { createHandler } = require('../lambda/dashboard');
const auth = require('../lambda/dashboard/auth');

const env = { SITES: 'root=dliu.com,cyy=cyy.dliu.com,xiangqi=xiangqi.dliu.com', GLUE_DATABASE: 'traffic', GLUE_TABLE: 'cloudfront_logs', ROOT_DOMAIN: 'dliu.com' };
const NOW = Date.UTC(2026, 9, 9, 12, 30, 0);

describe('filters', () => {
  test('defaults to 7 days across all sites', () => {
    expect(parseFilters({}, NOW, env)).toEqual({ site: 'all', country: null, startDay: '2026-10-03', endDay: '2026-10-09', since: null, until: null, unit: 'day', bots: 'hide', now: NOW });
  });

  test('24h uses an hourly timestamp filter', () => {
    expect(parseFilters({ range: '24h', site: 'cyy' }, NOW, env))
      .toEqual({ site: 'cyy', country: null, startDay: '2026-10-08', endDay: '2026-10-09', since: '2026-10-08 12:30:00', until: null, unit: 'hour', bots: 'hide', now: NOW });
  });

  test('only 24h, 3d, 7d, 30d and 90d ranges', () => {
    expect(parseFilters({ range: '90d' }, NOW, env)).toMatchObject({ startDay: '2026-07-12', unit: 'day' });
    expect(parseFilters({ range: '3d' }, NOW, env)).toMatchObject({ startDay: '2026-10-07', endDay: '2026-10-09', unit: 'day' });
    for (const range of ['1h', '12h', '365d', 'nope']) expect(() => parseFilters({ range }, NOW, env)).toThrow(BadRequest);
  });

  test('custom ranges with times', () => {
    expect(parseFilters({ from: '2026-10-07T22:15Z', to: '2026-10-08T01:00:00Z' }, NOW, env))
      .toEqual({ site: 'all', country: null, startDay: '2026-10-07', endDay: '2026-10-08', since: '2026-10-07 22:15:00', until: '2026-10-08 01:00:00', unit: 'minute', bots: 'hide', now: NOW });
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
    [{ country: 'jp' }],
    [{ country: 'JPN' }],
    [{ country: "JP' OR 1=1 --" }],
    [{ country: 'Unknown' }],
  ])('rejects %j', (query) => {
    expect(() => parseFilters(query, NOW, env)).toThrow(BadRequest);
  });
});

describe('country filter', () => {
  test('applies to every overview and list query', () => {
    const filters = parseFilters({ country: 'JP', range: '7d' }, NOW, env);
    expect(filters.country).toBe('JP');
    for (const sql of Object.values(overviewQueries(filters, env))) expect(sql).toContain("AND c_country = 'JP'");
    for (const list of ['ips', 'countries', 'pages', 'referrers', 'requests']) {
      expect(listQuery(filters, { list }, env).sql).toContain("AND c_country = 'JP'");
    }
    expect(base(parseFilters({ country: 'unknown' }, NOW, env), env)).toContain("AND coalesce(c_country, '-') = '-'");
    expect(base(parseFilters({}, NOW, env), env)).not.toContain('AND c_country');
  });

  test('is ignored on the IP page, which always covers everything an IP did', () => {
    const filters = parseFilters({ country: 'JP' }, NOW, env);
    for (const sql of Object.values(ipQueries(filters, '192.0.2.1', env))) expect(sql).not.toContain('c_country =');
    for (const list of ['related', 'cookies']) expect(listQuery(filters, { list, ip: '192.0.2.1' }, env).sql).not.toContain('c_country =');
  });

  test('countries list ranks countries by visitors', () => {
    const { sql } = listQuery(parseFilters({}, NOW, env), { list: 'countries', q: 'jp' }, env);
    expect(sql).toContain("coalesce(country, 'unknown') AS country");
    expect(sql).toContain("nullif(c_country, '-') AS country");
    expect(sql).toMatch(/ORDER BY visitors DESC, requests DESC, country\n/);
    expect(sql).toContain(", 'jp') > 0");
  });
});

describe('bot filter', () => {
  test('bots are hidden unless included', () => {
    expect(parseFilters({ bots: 'include' }, NOW, env).bots).toBe('include');
    expect(parseFilters({ bots: 'only' }, NOW, env).bots).toBe('only');
    for (const bad of ['yes', 'HIDE', "include'"]) expect(() => parseFilters({ bots: bad }, NOW, env)).toThrow(BadRequest);
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

  test('visitor id is the cookie, or the logged id once the browser sent it back', () => {
    const sql = overviewQueries(filters, env).summary;
    expect(sql).toContain("regexp_extract(url_decode(cs_cookie), 'dl_vid=([a-z0-9]{8,40})', 1) AS cookie_id");
    expect(sql).toContain("regexp_extract(vid_log, '^([a-z0-9]{8,40})(\\.|$)', 1) AS logged_id");
    expect(sql).toContain('bool_or(cookie_id IS NOT NULL) OVER (PARTITION BY coalesce(logged_id, ip)) THEN logged_id END) AS visitor_id');
    expect(sql).toMatch(/FROM r\n    WHERE ts >= [^\n]+\n  \), v AS/);
    expect(sql).toContain("CASE WHEN regexp_like(asn, '^[0-9]{1,10}$') THEN asn END AS asn");
    expect(sql).not.toMatch(/--/);
  });

  test('city comes from the logged data, well-formed and validated', () => {
    const sql = overviewQueries(filters, env).summary;
    expect(sql).toContain("from_utf8(from_hex(regexp_extract(vid_log, '^[a-z0-9]{8,40}\\.((?:[0-9a-f]{2}){1,240})$', 1))) AS city_raw");
    expect(sql).toContain("CASE WHEN regexp_like(city_raw, '^[\\p{L}\\p{M}\\p{N} .''’(),-]{1,60}$') THEN city_raw END AS city");
    const last = 'max_by(city, ts) FILTER (WHERE city IS NOT NULL) AS city';
    expect(ipQueries(filters, '203.0.113.7', env).summary).toContain(last);
    for (const list of ['ips', 'related']) expect(listQuery(filters, { list, ip: '203.0.113.7' }, env).sql).toContain(last);
    expect(listQuery(filters, { list: 'requests' }, env).sql).toContain('ip, country, city, asn, visitor_id');
    expect(listQuery(filters, { list: 'ips', q: 'São Paulo' }, env).sql).toContain("coalesce(cast(city AS varchar), '')");
  });

  test('ip summary and ip list include the network (ASN)', () => {
    expect(ipQueries(filters, '203.0.113.7', env).summary).toContain('max_by(asn, ts) AS asn');
    expect(listQuery(filters, { list: 'ips' }, env).sql).toContain('max_by(asn, ts) AS asn');
  });

  test('ip queries cover every site and validate the IP', () => {
    const queries = ipQueries(filters, '203.0.113.7', env);
    expect(Object.keys(queries)).toEqual(['summary', 'sites', 'reputation']);
    expect(queries.reputation).toContain('FROM "traffic"."ip_reputation"');
    for (const sql of Object.values(queries)) {
      expect(sql).toContain("ip = '203.0.113.7'");
      expect(sql).not.toContain("AND site = 'cyy'");
    }
    for (const bad of [undefined, '', "1.1.1.1' OR '1'='1", '1.1.1.1;--', '<script>']) {
      expect(() => ipQueries(filters, bad, env)).toThrow(BadRequest);
    }
  });

  test('lists return one page with a total', () => {
    const { sql, limit, offset } = listQuery(filters, { list: 'ips', limit: '15', offset: '30' }, env);
    expect([limit, offset]).toEqual([15, 30]);
    expect(sql).toContain('count(*) OVER () AS total');
    expect(sql).toContain("AND site = 'cyy'");
    expect(sql).toMatch(/\nORDER BY last_seen DESC, ip\nOFFSET 30 LIMIT 15$/);
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
    expect(listQuery(filters, { list: 'requests', visitor: 'abc123def456' }, env).sql)
      .toContain("WHERE visitor_id = 'abc123def456'\n");
    expect(listQuery(filters, { list: 'requests', ip: '2001:db8::1' }, env).sql).toContain("ip = '2001:db8::1'");
    expect(() => listQuery(filters, { list: 'requests', visitor: "x' OR '1'='1" }, env)).toThrow(BadRequest);
    expect(() => listQuery(filters, { list: 'requests', ip: "1.1.1.1'--" }, env)).toThrow(BadRequest);
    for (const list of [undefined, 'nope', '__proto__', 'constructor']) {
      expect(() => listQuery(filters, { list }, env)).toThrow(BadRequest);
    }
  });
});

describe('bots', () => {
  const hidden = parseFilters({ site: 'cyy' }, NOW, env);
  const shown = parseFilters({ site: 'cyy', bots: 'include' }, NOW, env);
  const DROP = 'WHERE bot_reason IS NULL';

  test('bots (by user agent or the daily verdicts) are dropped by default, kept with bots=include', () => {
    const sql = overviewQueries(hidden, env).summary;
    expect(sql).toContain(DROP);
    expect(sql).toContain("coalesce(ua, '') IN ('', '-')");
    expect(sql).toContain('FROM "traffic"."bot_ips"');
    expect(sql).toContain("WHERE dt BETWEEN '2026-10-03' AND '2026-10-09'");
    expect(sql).toContain('LEFT JOIN b ON bot_dt = dt AND bot_ip = c_ip');
    expect(sql).toContain("AND site = 'cyy'");
    expect(sql).not.toMatch(/asn IN \(/);
    expect(overviewQueries(shown, env).summary).not.toContain(DROP);
    for (const list of ['ips', 'pages', 'page_ips']) {
      expect(listQuery(hidden, { list, path: '/a' }, env).sql).toContain(DROP);
      expect(listQuery(shown, { list, path: '/a' }, env).sql).not.toContain(DROP);
    }
  });

  test('IP views always include bots', () => {
    for (const sql of Object.values(ipQueries(hidden, '203.0.113.7', env))) expect(sql).not.toContain(DROP);
    for (const list of ['related', 'cookies', 'requests']) {
      expect(listQuery(hidden, { list, ip: '203.0.113.7' }, env).sql).not.toContain(DROP);
    }
    expect(listQuery(hidden, { list: 'requests' }, env).sql).toContain(DROP);
  });
});

describe('daily folders and the monthly archive', () => {
  // NOW is 2026-10-09: days from 10-02 may still be in daily folders, days up to 10-05 may be archived.
  test('recent ranges read only the daily folders', () => {
    for (const range of ['24h', '3d']) {
      const filters = parseFilters({ range }, NOW, env);
      expect(layout(filters).archive).toBeNull();
      const sql = overviewQueries(filters, env).summary;
      expect(sql).toContain('FROM "traffic"."cloudfront_logs"');
      expect(sql).not.toContain('cloudfront_logs_archive');
    }
  });

  test('longer ranges add the archive by month, and bot verdicts only for the daily days', () => {
    const filters = parseFilters({ range: '90d', site: 'cyy', country: 'GB' }, NOW, env);
    expect(layout(filters)).toEqual({ daily: { from: '2026-10-02', to: '2026-10-09' }, archive: { from: '2026-07-12', to: '2026-10-05' } });
    const sql = overviewQueries(filters, env).summary;
    expect(sql).toContain("FROM \"traffic\".\"cloudfront_logs\"\n    WHERE dt BETWEEN '2026-10-02' AND '2026-10-09' AND site = 'cyy'");
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain("FROM \"traffic\".\"cloudfront_logs_archive\"\n    WHERE month BETWEEN '2026-07' AND '2026-10'\n      AND dt BETWEEN '2026-07-12' AND '2026-10-05' AND site = 'cyy'");
    expect(sql).toMatch(/FROM "traffic"."bot_ips"\n    WHERE dt BETWEEN '2026-10-02' AND '2026-10-09'\n/);
    expect(sql).toContain("AND c_country = 'GB'");
  });

  test('an old custom range reads only the archive and joins no bot verdicts', () => {
    const filters = parseFilters({ from: '2026-08-01', to: '2026-08-31' }, NOW, env);
    expect(layout(filters)).toEqual({ daily: null, archive: { from: '2026-08-01', to: '2026-08-31' } });
    const sql = overviewQueries(filters, env).summary;
    expect(sql).not.toContain('"traffic"."cloudfront_logs"\n');
    expect(sql).toContain("month BETWEEN '2026-08' AND '2026-08'");
    expect(sql).toMatch(/FROM "traffic"."bot_ips"\n    WHERE dt BETWEEN '2026-08-01' AND '2026-08-01' AND false/);
  });
});

describe('bots page', () => {
  const filters = parseFilters({ range: '3d' }, NOW, env);
  const ONLY = 'WHERE bot_reason IS NOT NULL';

  test('every bot query keeps only bots, whatever the filters say', () => {
    for (const sql of Object.values(botQueries({ ...filters, bots: 'hide' }, env))) {
      expect(sql).toContain(ONLY);
      expect(sql).not.toContain('WHERE bot_reason IS NULL');
      expect(sql).toContain("WHERE dt BETWEEN '2026-10-07' AND '2026-10-09'");
    }
    const only = parseFilters({ range: '3d', bots: 'only' }, NOW, env);
    for (const list of ['ips', 'agents', 'requests']) expect(listQuery(only, { list }, env).sql).toContain(ONLY);
    expect(listQuery(only, { list: 'agents', q: 'curl' }, env).sql).toMatch(/GROUP BY ua[\s\S]*ORDER BY requests DESC/);
  });

  test('/api/bot-records needs sign-in and forces bots only', async () => {
    const config = { tenantId: 't', clientId: 'c', clientSecret: 's', allowedDomain: 'example.com' };
    const session = auth.sign({ user: 'user@example.com', exp: Math.floor(NOW / 1000) + 600 }, auth.sessionKey(config));
    const seen = [];
    const handler = createHandler({ loadConfig: async () => config, runQuery: async (sql) => { seen.push(sql); return []; }, now: () => NOW });
    Object.assign(process.env, env);
    const call = (query, extra = {}) => handler({ rawPath: '/api/bot-records', queryStringParameters: query, requestContext: { http: { method: 'GET' } }, ...extra });
    expect((await call({ part: 'summary' })).statusCode).toBe(401);
    const response = await call({ part: 'reasons', range: '3d', bots: 'hide' }, { cookies: [`${auth.SESSION_COOKIE}=${session}`] });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).filters.bots).toBe('only');
    expect(seen[0]).toContain(ONLY);
    expect((await call({ part: 'nope' }, { cookies: [`${auth.SESSION_COOKIE}=${session}`] })).statusCode).toBe(400);
  });
});

describe('page details', () => {
  const filters = parseFilters({ site: 'cyy', range: '7d' }, NOW, env);

  test('page lists and queries match one exact path, quotes escaped', () => {
    for (const list of ['page_visitors', 'page_ips']) {
      const { sql } = listQuery(filters, { list, path: "/game/it's 围棋" }, env);
      expect(sql).toContain("is_page AND");
      expect(sql).toContain("path = '/game/it''s 围棋'");
      expect(sql).toContain("AND site = 'cyy'");
    }
    expect(listQuery(filters, { list: 'requests', path: '/a' }, env).sql).toContain("WHERE path = '/a'");
    const { summary, timeseries } = pageQueries(filters, '/game/1', env);
    expect(summary).toContain("WHERE is_page AND path = '/game/1'");
    expect(timeseries).toContain("date_trunc('day', ts)");
  });

  test('page path must be a logged path', () => {
    for (const path of [undefined, '', 'game/1', 'https://cyy.dliu.com/', '/a\nb', '/a\u0000', `/${'x'.repeat(1001)}`]) {
      expect(() => listQuery(filters, { list: 'page_ips', path }, env)).toThrow(BadRequest);
      expect(() => pageQueries(filters, path, env)).toThrow(BadRequest);
    }
    expect(() => listQuery(filters, { list: 'requests', path: 'x' }, env)).toThrow(BadRequest);
    expect(() => pageQueries(parseFilters({}, NOW, env), '/a', env)).toThrow(BadRequest);
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

  test('networks come from the hosting list and are cached by the browser', async () => {
    const custom = createHandler({
      loadConfig: async () => config,
      runQuery: async (sql) => { queries.push(sql); return [{ n: '1' }]; },
      loadHosting: async () => ({ 64500: 'Example Cloud' }),
      now: () => NOW,
    });
    const call = (path, extra = {}) => custom({ rawPath: path, requestContext: { http: { method: 'GET' } }, ...extra });
    expect((await call('/api/networks')).statusCode).toBe(401);
    const response = await call('/api/networks', signedIn);
    expect(response.headers['cache-control']).toBe('private, max-age=3600');
    expect(JSON.parse(response.body)).toEqual({ networks: { 64500: 'Example Cloud' } });
  });

  describe('bot check', () => {
    const SITE = 'https://traffic.dliu.com';
    const setup = (stored, { invokeFails = false } = {}) => {
      const writes = [];
      const invokes = [];
      const s3 = {
        send: async (command) => {
          const name = command.constructor.name;
          if (name === 'GetObjectCommand') {
            if (!stored) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
            return { Body: { transformToString: async () => JSON.stringify(stored) } };
          }
          writes.push({ key: command.input.Key, body: JSON.parse(command.input.Body) });
          return {};
        },
      };
      const lambda = { send: async (command) => { if (invokeFails) throw new Error('nope'); invokes.push(command.input); return {}; } };
      const custom = createHandler({ loadConfig: async () => config, runQuery: async () => [], s3, lambda, now: () => NOW });
      const call = (path, method, extra = {}) => custom({ rawPath: path, requestContext: { http: { method } }, ...extra });
      return { writes, invokes, call };
    };
    const post = (origin = SITE) => ({ ...signedIn, headers: { origin } });

    beforeAll(() => { process.env.BOTS_BUCKET = 'logs'; process.env.BOTS_FUNCTION = 'classifier'; });

    test('run is POST only, needs a session and the dashboard origin', async () => {
      const { call, invokes } = setup(null);
      expect((await call('/api/bots/run', 'GET', signedIn)).statusCode).toBe(405);
      expect((await call('/api/bots', 'POST', signedIn)).statusCode).toBe(405);
      expect((await call('/api/bots/run', 'POST', { headers: { origin: SITE } })).statusCode).toBe(401);
      expect((await call('/api/bots/run', 'POST', post('https://evil.example'))).statusCode).toBe(403);
      expect((await call('/api/bots/run', 'POST', { ...signedIn })).statusCode).toBe(403);
      expect(invokes).toHaveLength(0);
    });

    test('run starts the classifier in the background and records it', async () => {
      const { call, invokes, writes } = setup({ state: 'done', started: '2026-10-08T00:30:00.000Z' });
      const response = await call('/api/bots/run', 'POST', post());
      expect(response.statusCode).toBe(202);
      expect(JSON.parse(response.body).status).toMatchObject({ state: 'running', trigger: 'dashboard' });
      expect(writes).toEqual([{ key: 'bots/status.json', body: expect.objectContaining({ state: 'running' }) }]);
      expect(invokes).toEqual([{ FunctionName: 'classifier', InvocationType: 'Event', Payload: JSON.stringify({ trigger: 'dashboard', includeToday: true }) }]);
    });

    test('only one run at a time; a stale run does not block', async () => {
      const running = { state: 'running', started: new Date(NOW - 60000).toISOString() };
      const busy = setup(running);
      expect((await busy.call('/api/bots/run', 'POST', post())).statusCode).toBe(409);
      expect(busy.invokes).toHaveLength(0);
      const stale = setup({ state: 'running', started: new Date(NOW - 20 * 60000).toISOString() });
      expect((await stale.call('/api/bots/run', 'POST', post())).statusCode).toBe(202);
    });

    test('a failed start is recorded as failed', async () => {
      const { call, writes } = setup(null, { invokeFails: true });
      expect((await call('/api/bots/run', 'POST', post())).statusCode).toBe(500);
      expect(writes.map((w) => w.body.state)).toEqual(['running', 'failed']);
    });

    test('status reports the last run, and a stale run as failed', async () => {
      expect(JSON.parse((await setup(null).call('/api/bots', 'GET', signedIn)).body)).toEqual({ status: null });
      const done = { state: 'done', started: '2026-10-08T00:30:00.000Z', finished: '2026-10-08T00:31:00.000Z' };
      expect(JSON.parse((await setup(done).call('/api/bots', 'GET', signedIn)).body)).toEqual({ status: done });
      const stale = { state: 'running', started: new Date(NOW - 20 * 60000).toISOString() };
      expect(JSON.parse((await setup(stale).call('/api/bots', 'GET', signedIn)).body).status.state).toBe('failed');
      expect((await setup(done).call('/api/bots', 'GET')).statusCode).toBe(401);
    });
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
    expect(queries).toHaveLength(3);
    expect(JSON.parse(response.body).filters.site).toBe('all');
    expect((await request('/api/ip', { ...signedIn, queryStringParameters: { ip: "x'" } })).statusCode).toBe(400);
  });

  test('page view runs its queries for one site and path', async () => {
    queries.length = 0;
    const response = await request('/api/page', { ...signedIn, queryStringParameters: { site: 'cyy', path: '/game/1', range: '7d' } });
    expect(response.statusCode).toBe(200);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("path = '/game/1'");
    expect((await request('/api/page', { ...signedIn, queryStringParameters: { site: 'cyy', path: 'nope' } })).statusCode).toBe(400);
    expect((await request('/api/page', { ...signedIn, queryStringParameters: { path: '/a' } })).statusCode).toBe(400);
  });

  test('part runs a single query', async () => {
    queries.length = 0;
    const response = await request('/api/overview', { ...signedIn, queryStringParameters: { range: '24h', part: 'timeseries' } });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("date_trunc('hour', ts)");
    expect(JSON.parse(response.body)).toMatchObject({ filters: { unit: 'hour' }, rows: [{ n: '1' }] });
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

describe('abuse-check', () => {
  const { summarize, reputationQueries } = require('../lambda/dashboard/abuse');
  const run = (started, trigger, from, to, days, extra = {}) => ({ version: 1, started, finished: started, trigger, from, to, looked_up: 0, limit_hit: false, remaining: null, failures: 0, days, ...extra });
  const c = (o) => ({ seen: 0, people: 0, skipped: 0, queued: 0, looked_up: 0, left: 0, abusive: 0, ...o });

  test('summarizes lookups per day, per log day, waiting and dropped IPs', () => {
    const runs = [
      run('2026-10-08T00:30:00.000Z', 'schedule', '2026-10-05', '2026-10-07', {
        '2026-10-07': c({ seen: 50, people: 40, queued: 30, looked_up: 20, left: 10 }),
        '2026-10-05': c({ seen: 9, queued: 4, left: 4 }),
      }, { looked_up: 900, limit_hit: true, remaining: 0 }),
      run('2026-10-09T00:30:00.000Z', 'schedule', '2026-10-06', '2026-10-08', {
        '2026-10-08': c({ seen: 70, queued: 60, looked_up: 55, left: 5, abusive: 3 }),
        '2026-10-07': c({ seen: 50, queued: 10, looked_up: 10, abusive: 1 }),
        '2026-10-06': c({ seen: 8, queued: 2, left: 2 }),
      }, { looked_up: 65, remaining: 935 }),
      run('2026-10-09T10:00:00.000Z', 'dashboard', '2026-10-06', '2026-10-09', {
        '2026-10-09': c({ seen: 5, queued: 1, looked_up: 1 }),
        '2026-10-08': c({ seen: 71, queued: 5, left: 5 }),
      }, { looked_up: 1, remaining: 934 }),
    ];
    const out = summarize(runs, NOW);
    expect(out.today).toEqual({ looked_up: 66, remaining: 934, limit_hit: false });
    expect(out.runs[1]).toMatchObject({ day: '2026-10-08', looked_up: 900, limit_hit: true });
    expect(out.waiting).toBe(5);
    expect(out.next_run).toBe('2026-10-10T00:30:00.000Z');
    const day = (d) => out.days.find((r) => r.day === d);
    expect(day('2026-10-07')).toMatchObject({ looked_up: 30, abusive: 1, left: 0, dropped: null });
    expect(day('2026-10-05').dropped).toBe(4);
    expect(day('2026-10-06').dropped).toBe(2);
    expect(day('2026-10-08').seen).toBe(71);
  });

  test('reputation queries cover 30 days and cap the abusive list', () => {
    const q = reputationQueries(NOW, env);
    expect(Object.keys(q)).toEqual(['summary', 'scores', 'usage', 'abusive']);
    for (const sql of Object.values(q)) expect(sql).toContain("WHERE dt BETWEEN '2026-09-10' AND '2026-10-09'");
    expect(q.abusive).toContain('LIMIT 500');
  });

  test('/api/abuse needs sign-in and validates the part', async () => {
    const config = { tenantId: 't', clientId: 'c', clientSecret: 's', allowedDomain: 'example.com' };
    const session = auth.sign({ user: 'user@example.com', exp: Math.floor(NOW / 1000) + 600 }, auth.sessionKey(config));
    const s3 = { send: async (cmd) => (cmd.constructor.name === 'ListObjectsV2Command'
      ? { Contents: [{ Key: 'abuseipdb/runs/dt=2026-10-09/20261009T003000000Z.json' }, { Key: 'abuseipdb/runs/../x' }] }
      : { Body: { transformToString: async () => JSON.stringify(run('2026-10-09T00:30:00.000Z', 'schedule', '2026-10-06', '2026-10-08', { '2026-10-08': c({ left: 7 }) })) } }) };
    const handler = createHandler({ loadConfig: async () => config, runQuery: async () => [{ ips: '3' }], s3, now: () => NOW });
    Object.assign(process.env, env, { BOTS_BUCKET: 'logs' });
    const call = (part, signed = true) => handler({ rawPath: '/api/abuse', queryStringParameters: { part }, requestContext: { http: { method: 'GET' } }, ...(signed ? { cookies: [`${auth.SESSION_COOKIE}=${session}`] } : {}) });
    expect((await call('runs', false)).statusCode).toBe(401);
    const runs = JSON.parse((await call('runs')).body);
    expect(runs.waiting).toBe(7);
    expect(JSON.parse((await call('summary')).body).rows).toEqual([{ ips: '3' }]);
    expect((await call('nope')).statusCode).toBe(400);
  });
});
