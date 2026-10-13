const bots = require('../lambda/dashboard/bots');

const NOW = Date.UTC(2026, 9, 9, 12, 30, 0);
const env = { SITES: 'root=dliu.com,cyy=cyy.dliu.com', GLUE_DATABASE: 'traffic', GLUE_TABLE: 'cloudfront_logs' };
const NETWORKS = { 16509: 'Amazon AWS' };

const row = (ip, extra = {}) => ({
  dt: '2026-10-08', ip, requests: '10', browser_requests: '10', asn: '3320', probe: 'false', loads_page: 'true', ...extra,
});

const response = (status, body, remaining = '500') => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
  headers: { get: (name) => (name === 'x-ratelimit-remaining' ? remaining : null) },
});
const abuse = (score, extra = {}) => ({ data: { abuseConfidenceScore: score, totalReports: score ? 7 : 0, usageType: 'Fixed Line ISP', isp: 'Example ISP', domain: 'example.net', isTor: false, ...extra } });

function setup(rows, { key = 'secret', fetchImpl, status } = {}) {
  const puts = [];
  const queries = [];
  const lookups = [];
  const s3 = {
    send: async (command) => {
      if (command.constructor.name === 'GetObjectCommand') {
        if (!status) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => JSON.stringify(status) } };
      }
      puts.push({ key: command.input.Key, body: command.input.Body });
      return {};
    },
  };
  const ssm = {
    send: async () => {
      if (!key) throw Object.assign(new Error('missing'), { name: 'ParameterNotFound' });
      return { Parameter: { Value: key } };
    },
  };
  const deps = {
    env, now: NOW, bucket: 'logs', s3, ssm,
    loadHosting: async () => NETWORKS,
    runQuery: async (sql, options) => { queries.push({ sql, options }); return rows; },
    fetchImpl: fetchImpl || (async (url, options) => { lookups.push({ url, options }); return response(200, abuse(0)); }),
  };
  const file = (key) => {
    const put = puts.find((p) => p.key === key);
    return put && put.body.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  return { deps, puts, queries, lookups, file };
}

describe('days to classify', () => {
  test('defaults to the 7 full days before today, newest first', () => {
    expect(bots.daysToClassify({}, NOW)).toEqual(['2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02']);
  });

  test('includes today when asked, and takes a number of days', () => {
    expect(bots.daysToClassify({ days: 2, includeToday: true }, NOW)).toEqual(['2026-10-09', '2026-10-08', '2026-10-07']);
    expect(bots.daysToClassify({ days: 1, includeToday: 'yes' }, NOW)).toEqual(['2026-10-08']);
  });

  test.each([0, 401, 1.5, 'x', -3])('rejects days=%p', (days) => {
    expect(() => bots.daysToClassify({ days }, NOW)).toThrow(/days/);
  });
});

describe('rules', () => {
  test('first matching reason wins: hosting, probe, abuse, headless', () => {
    const all = row('192.0.2.1', { asn: '16509', probe: 'true', loads_page: 'false' });
    expect(bots.verdict(all, NETWORKS, { score: 100 })).toBe('hosting');
    expect(bots.verdict({ ...all, asn: '3320' }, NETWORKS, { score: 100 })).toBe('probe');
    expect(bots.verdict({ ...all, asn: '3320', probe: false }, NETWORKS, { score: 100 })).toBe('abuse');
    expect(bots.verdict({ ...all, asn: '3320', probe: false }, NETWORKS, { score: 10 })).toBe('headless');
    expect(bots.verdict(row('192.0.2.1'), NETWORKS, { score: 10 })).toBeNull();
    expect(bots.verdict(row('192.0.2.1', { asn: null }), NETWORKS, null)).toBeNull();
  });

  test('abuse: high score, Tor, or a data centre outside networks that carry people', () => {
    expect(bots.isAbusive(null, '3320')).toBe(false);
    expect(bots.isAbusive({ score: 49 }, '3320')).toBe(false);
    expect(bots.isAbusive({ score: '50' }, '3320')).toBe(true);
    expect(bots.isAbusive({ score: 0, is_tor: 'true' }, '3320')).toBe(true);
    expect(bots.isAbusive({ score: 0, usage_type: bots.DATA_CENTER }, '3320')).toBe(true);
    expect(bots.isAbusive({ score: 0, usage_type: bots.DATA_CENTER }, '13335')).toBe(false);
    expect(bots.isAbusive({ score: 0, usage_type: 'Mobile ISP' }, '3320')).toBe(false);
  });

  test('scanner and page-file patterns', () => {
    const probe = new RegExp(bots.PROBE);
    for (const path of ['/.env', '/.git/config', '/wp-login.php', '/phpmyadmin/', '/index.php', '/backup.sql', '/x/.aws/credentials']) expect(probe.test(path)).toBe(true);
    for (const path of ['/', '/game/1', '/assets/app.js', '/environment', '/photos/a.jpg']) expect(probe.test(path)).toBe(false);
    const page = new RegExp(bots.PAGE_FILE);
    for (const path of ['/app.js', '/style.css', '/font.woff2']) expect(page.test(path)).toBe(true);
    for (const path of ['/', '/og.png', '/photo.jpg', '/app.json']) expect(page.test(path)).toBe(false);
  });

  test('features query reads the chosen days and recent AbuseIPDB results only', () => {
    const sql = bots.featuresSql('2026-10-02', '2026-10-08', env);
    expect(sql).toContain("WHERE dt BETWEEN '2026-10-02' AND '2026-10-08'");
    expect(sql).toContain('FROM "traffic"."ip_reputation"');
    expect(sql).toContain("WHERE dt >= '2026-06-04'");
    expect(() => bots.featuresSql("2026-10-02' OR 1=1", '2026-10-08', env)).toThrow();
  });

  test('saved AbuseIPDB results are reduced to plain values', () => {
    const result = bots.toResult('192.0.2.1', abuse(250, { usageType: '<script>x</script>', domain: 'bad domain<', isTor: 'true', totalReports: -4 }), '2026-10-09T12:30:00Z');
    expect(result).toMatchObject({ ip: '192.0.2.1', score: 100, reports: 0, domain: null, is_tor: false, checked: '2026-10-09T12:30:00Z' });
    expect(result.usage_type || '').not.toMatch(/[<>]/);
    expect(() => bots.toResult('192.0.2.1', { errors: [] }, 'x')).toThrow();
  });

  test('only real IP addresses are kept', () => {
    for (const ip of ['192.0.2.1', '2001:db8::1']) expect(bots.validIp(ip)).toBe(true);
    for (const ip of ['', '-', "1.1.1.1'", '999.1.1.1', null]) expect(bots.validIp(ip)).toBe(false);
  });
});

describe('daily run', () => {
  test('flags each IP per day, looks up only possible people, once each', async () => {
    const rows = [
      row('192.0.2.1', { asn: '16509' }),
      row('192.0.2.2', { probe: 'true' }),
      row('192.0.2.3', { requests: '50' }),
      row('192.0.2.3', { dt: '2026-10-07' }),
      row('192.0.2.4', { loads_page: 'false' }),
      row('192.0.2.5', { score: '0', checked: '2026-10-01T00:00:00Z' }),
      row('192.0.2.6', { score: '0', checked: '2026-08-01T00:00:00Z' }),
      row('192.0.2.7', { browser_requests: '0' }),
      row('not-an-ip'),
      row('192.0.2.8', { dt: '2026-09-01' }),
    ];
    const fetchImpl = async (url, options) => {
      t.lookups.push({ url, options });
      return response(200, abuse(url.includes('192.0.2.3') ? 100 : 0));
    };
    const t = setup(rows, { fetchImpl });
    const summary = await bots.update({}, t.deps);

    expect(t.queries[0].options).toMatchObject({ maxRows: 1000000 });
    expect(t.lookups.map((l) => new URL(l.url).searchParams.get('ipAddress'))).toEqual(['192.0.2.3', '192.0.2.6']);
    expect(t.lookups[0].options.headers).toEqual({ Key: 'secret', Accept: 'application/json' });
    expect(t.file('bots/dt=2026-10-08/bots.json')).toEqual([
      { ip: '192.0.2.1', reason: 'hosting' },
      { ip: '192.0.2.2', reason: 'probe' },
      { ip: '192.0.2.3', reason: 'abuse' },
      { ip: '192.0.2.4', reason: 'headless' },
    ]);
    expect(t.file('bots/dt=2026-10-07/bots.json')).toEqual([{ ip: '192.0.2.3', reason: 'abuse' }]);
    expect(t.puts.some((p) => p.key.includes('2026-09-01'))).toBe(false);
    const saved = t.file(t.puts.find((p) => p.key.startsWith('reputation/dt=2026-10-09/')).key);
    expect(saved.map((r) => [r.ip, r.score])).toEqual([['192.0.2.3', 100], ['192.0.2.6', 0]]);
    expect(summary).toMatchObject({
      from: '2026-10-02', to: '2026-10-08', days: 2, bots: { hosting: 1, probe: 1, abuse: 2, headless: 1 },
      abuseipdb: { wanted: 2, checked: 2, left: 0, failures: 0, stopped: null },
    });
    const statuses = t.puts.filter((p) => p.key === bots.STATUS_KEY).map((p) => JSON.parse(p.body));
    expect(statuses.map((s) => s.state)).toEqual(['running', 'done']);
    expect(statuses[1]).toMatchObject({ trigger: 'schedule', summary: { days: 2 } });
  });

  test('days with no bots still get an empty file, replacing old verdicts', async () => {
    const t = setup([row('192.0.2.5', { score: '0', checked: '2026-10-01T00:00:00Z' })]);
    await bots.update({}, t.deps);
    expect(t.puts.find((p) => p.key === 'bots/dt=2026-10-08/bots.json').body).toBe('');
  });

  test('stops at the daily limit and leaves the rest for the next run', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`198.51.100.${i + 1}`, { requests: String(100 - i) }));
    let calls = 0;
    const t = setup(rows, { fetchImpl: async () => (++calls <= 3 ? response(200, abuse(0)) : response(429, {})) });
    const summary = await bots.update({}, t.deps);
    expect(summary.abuseipdb).toMatchObject({ wanted: 30, checked: 3, left: 27, stopped: 'daily limit reached' });
    expect(calls).toBeLessThanOrEqual(3 + 4);
  });

  test('stops after the last allowed lookup', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`198.51.100.${i + 1}`));
    let calls = 0;
    const t = setup(rows, { fetchImpl: async () => response(200, abuse(0), ++calls >= 2 ? '0' : '5') });
    const summary = await bots.update({}, t.deps);
    expect(summary.abuseipdb.stopped).toBe('daily limit reached');
    expect(summary.abuseipdb.checked).toBeLessThan(10);
  });

  test('looks up at most 900 IPs a run, busiest first', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(`10.0.${Math.floor(i / 250)}.${i % 250}`, { requests: String(i) }));
    const t = setup(rows);
    const summary = await bots.update({}, t.deps);
    expect(summary.abuseipdb).toMatchObject({ wanted: bots.MAX_CHECKS, checked: 900 });
    expect(new URL(t.lookups[0].url).searchParams.get('ipAddress')).toBe('10.0.3.249');
  });

  test('without a key every other rule still runs', async () => {
    const t = setup([row('192.0.2.1', { asn: '16509' }), row('192.0.2.3')], { key: null });
    const summary = await bots.update({ trigger: 'dashboard', includeToday: true, days: 1 }, t.deps);
    expect(t.lookups).toHaveLength(0);
    expect(summary.abuseipdb).toEqual({ checked: 0, failures: 0, stopped: 'no API key' });
    expect(t.file('bots/dt=2026-10-08/bots.json')).toEqual([{ ip: '192.0.2.1', reason: 'hosting' }]);
    expect(JSON.parse(t.puts[0].body)).toMatchObject({ state: 'running', trigger: 'dashboard' });
  });

  test('a failed run is recorded as failed', async () => {
    const t = setup([]);
    t.deps.runQuery = async () => { throw new Error('Athena down'); };
    await expect(bots.update({}, t.deps)).rejects.toThrow('Athena down');
    const last = JSON.parse(t.puts[t.puts.length - 1].body);
    expect(last).toMatchObject({ state: 'failed' });
    expect(last.error).not.toContain('Athena');
  });

  test('status reads the last run and ignores a missing file', async () => {
    expect(await bots.readStatus(setup([]).deps.s3, 'logs')).toBeNull();
    expect(await bots.readStatus(setup([], { status: { state: 'done' } }).deps.s3, 'logs')).toEqual({ state: 'done' });
  });
});
