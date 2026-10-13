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

// An in-memory bucket: puts are kept (and listed in order), gets and lists are recorded.
function fakeS3(objects = {}) {
  const store = new Map(Object.entries(objects).map(([key, body]) => [key, typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)]));
  const puts = [];
  const gets = [];
  const lists = [];
  const s3 = {
    send: async (command) => {
      const { Key, Prefix, Body, StartAfter } = command.input;
      switch (command.constructor.name) {
        case 'GetObjectCommand': {
          gets.push(Key);
          if (!store.has(Key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
          const body = Buffer.from(store.get(Key));
          return { Body: { transformToString: async () => body.toString('utf8'), transformToByteArray: async () => new Uint8Array(body) } };
        }
        case 'ListObjectsV2Command':
          lists.push(Prefix);
          return { Contents: [...store.keys()].filter((key) => key.startsWith(Prefix) && (!StartAfter || key > StartAfter)).sort().map((key) => ({ Key: key })) };
        case 'PutObjectCommand':
          puts.push({ key: Key, body: Body });
          store.set(Key, Body);
          return {};
        default:
          throw new Error(`unexpected ${command.constructor.name}`);
      }
    },
  };
  return { s3, store, puts, gets, lists };
}

// Features as the bot-state module gives them, built from rows that may carry a saved AbuseIPDB result.
const injected = (rows, calls) => async () => {
  const reputation = new Map();
  for (const r of rows) if (r.checked && !reputation.has(r.ip)) reputation.set(r.ip, { ip: r.ip, score: r.score, checked: r.checked });
  return {
    rows, reputation, read: 0,
    saveReputation: async () => { calls.saveReputation++; },
    save: async () => { calls.save++; },
  };
};

function setup(rows, { key = 'secret', fetchImpl, status, objects } = {}) {
  const queries = [];
  const lookups = [];
  const calls = { save: 0, saveReputation: 0 };
  const bucket = fakeS3({ ...objects, ...(status ? { [bots.STATUS_KEY]: status } : {}) });
  const ssm = {
    send: async () => {
      if (!key) throw Object.assign(new Error('missing'), { name: 'ParameterNotFound' });
      return { Parameter: { Value: key } };
    },
  };
  const deps = {
    env, now: NOW, bucket: 'logs', s3: bucket.s3, ssm,
    loadHosting: async () => NETWORKS,
    runQuery: async (sql, options) => { queries.push({ sql, options }); return []; },
    fetchImpl: fetchImpl || (async (url, options) => { lookups.push({ url, options }); return response(200, abuse(0)); }),
  };
  if (rows) deps.loadFeatures = injected(rows, calls);
  const file = (key) => {
    const put = [...bucket.puts].reverse().find((p) => p.key === key);
    return put && put.body.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  return { deps, puts: bucket.puts, gets: bucket.gets, lists: bucket.lists, store: bucket.store, queries, lookups, calls, file };
}

describe('days to classify', () => {
  test('defaults to today and the 3 days before, newest first', () => {
    expect(bots.daysToClassify({}, NOW)).toEqual(['2026-10-09', '2026-10-08', '2026-10-07', '2026-10-06']);
  });

  test('leaves today out when asked, and takes a number of days', () => {
    expect(bots.daysToClassify({ days: 2, includeToday: true }, NOW)).toEqual(['2026-10-09', '2026-10-08', '2026-10-07']);
    expect(bots.daysToClassify({ days: 1, includeToday: false }, NOW)).toEqual(['2026-10-08']);
  });

  test.each([0, 8, 1.5, 'x', -3])('rejects days=%p', (days) => {
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

  test('the reputation query (run once, to build the cache) reads recent results only', () => {
    const sql = bots.reputationSql('2026-06-11', env);
    expect(sql).toContain('FROM "traffic"."ip_reputation"');
    expect(sql).toContain("WHERE dt >= '2026-06-11'");
    expect(() => bots.reputationSql("2026-06-11' OR 1=1", env)).toThrow();
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
      from: '2026-10-06', to: '2026-10-09', days: 2, bots: { hosting: 1, probe: 1, abuse: 2, headless: 1 },
      abuseipdb: { wanted: 2, checked: 2, left: 0, failures: 0, stopped: null },
    });
    const statuses = t.puts.filter((p) => p.key === bots.STATUS_KEY).map((p) => JSON.parse(p.body));
    expect(statuses.map((s) => s.state)).toEqual(['running', 'done']);
    expect(statuses[1]).toMatchObject({ trigger: 'schedule', summary: { days: 2 } });
    expect(t.calls).toEqual({ save: 1, saveReputation: 1 });
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

  test("shares the day's 1,000 lookups with today's earlier runs, busiest first", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`10.0.0.${i + 1}`, { requests: String(i) }));
    const earlier = { 'abuseipdb/runs/dt=2026-10-09/20260909T003000000Z.json': { looked_up: 980, failures: 10, limit_hit: false, remaining: 900 } };
    const t = setup(rows, { objects: earlier });
    const summary = await bots.update({}, t.deps);
    expect(summary.abuseipdb).toMatchObject({ wanted: 30, checked: 10, left: 20 });
    expect(new URL(t.lookups[0].url).searchParams.get('ipAddress')).toBe('10.0.0.30');
    // Yesterday's runs don't count.
    const fresh = setup(rows, { objects: { 'abuseipdb/runs/dt=2026-10-08/20260908T003000000Z.json': { looked_up: 1000 } } });
    expect((await bots.update({}, fresh.deps)).abuseipdb).toMatchObject({ checked: 30, left: 0 });
  });

  test('looks nothing up once an earlier run today hit the limit', async () => {
    const t = setup([row('10.0.0.1')], { objects: { 'abuseipdb/runs/dt=2026-10-09/20260909T003000000Z.json': { looked_up: 3, limit_hit: true } } });
    const summary = await bots.update({}, t.deps);
    expect(t.lookups).toHaveLength(0);
    expect(summary.abuseipdb).toMatchObject({ checked: 0, stopped: 'daily limit reached' });
    const run = JSON.parse(t.puts.find((p) => p.key.startsWith('abuseipdb/runs/dt=2026-10-09/20261009')).body);
    expect(run).toMatchObject({ looked_up: 0, remaining: 0, days: { '2026-10-08': { queued: 1, left: 1 } } });
  });

  test('a scheduled run skips while another is going; a stale run does not count', async () => {
    const running = { state: 'running', trigger: 'dashboard', started: new Date(NOW - 5 * 60 * 1000).toISOString() };
    const t = setup([row('10.0.0.1')], { status: running });
    expect(await bots.update({}, t.deps)).toEqual({ skipped: 'another bot check is still running' });
    expect(t.puts).toHaveLength(0);
    expect(t.lookups).toHaveLength(0);
    const stale = setup([row('10.0.0.1')], { status: { ...running, started: new Date(NOW - 20 * 60 * 1000).toISOString() } });
    expect(await bots.update({}, stale.deps)).toMatchObject({ abuseipdb: { checked: 1 } });
  });

  test('only IPs seen in the last 3 days are queued; each run saves its counts per day', async () => {
    const rows = [
      row('192.0.2.10', { dt: '2026-10-08', requests: '5' }),
      row('192.0.2.11', { dt: '2026-10-06', requests: '9' }),
      row('192.0.2.11', { dt: '2026-10-07' }),
      row('192.0.2.12', { dt: '2026-10-07', score: '0', checked: '2026-10-01T00:00:00Z' }),
      row('192.0.2.13', { dt: '2026-10-06', asn: '16509' }),
      row('192.0.2.14', { dt: '2026-10-05' }),
      row('192.0.2.15', { dt: '2026-10-06' }),
    ];
    let calls = 0;
    const t = setup(rows, { fetchImpl: async (url) => {
      t.lookups.push({ url });
      return ++calls <= 2 ? response(200, abuse(url.includes('192.0.2.10') ? 90 : 0), '417') : response(429, {});
    } });
    await bots.update({}, t.deps);
    // 192.0.2.14 was last seen 4 days ago: it is not looked up (it stays counted as a person).
    expect(t.lookups.map((l) => new URL(l.url).searchParams.get('ipAddress'))).toEqual(['192.0.2.10', '192.0.2.11', '192.0.2.15']);
    const run = JSON.parse(t.puts.find((p) => p.key.startsWith('abuseipdb/runs/dt=2026-10-09/')).body);
    expect(run).toMatchObject({ version: 1, trigger: 'schedule', from: '2026-10-06', to: '2026-10-09', limit: 1000, looked_up: 2, limit_hit: true, remaining: 0 });
    expect(run.days).toEqual({
      '2026-10-09': { seen: 0, people: 0, skipped: 0, queued: 0, looked_up: 0, left: 0, abusive: 0 },
      '2026-10-08': { seen: 1, people: 1, skipped: 0, queued: 1, looked_up: 1, left: 0, abusive: 1 },
      // 192.0.2.11 counts once, on its newest day.
      '2026-10-07': { seen: 2, people: 2, skipped: 1, queued: 1, looked_up: 1, left: 0, abusive: 0 },
      '2026-10-06': { seen: 3, people: 1, skipped: 0, queued: 1, looked_up: 0, left: 1, abusive: 0 },
    });
    expect(JSON.stringify(run)).not.toMatch(/192\.0\.2/);
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
    t.deps.loadFeatures = async () => { throw new Error('Athena down'); };
    await expect(bots.update({}, t.deps)).rejects.toThrow('Athena down');
    const last = JSON.parse(t.puts[t.puts.length - 1].body);
    expect(last).toMatchObject({ state: 'failed' });
    expect(last.error).not.toContain('Athena');
  });

  test('status reads the last run and ignores a missing file', async () => {
    expect(await bots.readStatus(setup([]).deps.s3, 'logs')).toBeNull();
    expect(bots.isRunning({ state: 'running', started: new Date(NOW - 60000).toISOString() }, NOW)).toBe(true);
    expect(bots.isRunning({ state: 'done', started: new Date(NOW - 60000).toISOString() }, NOW)).toBe(false);
    expect(await bots.readStatus(setup([], { status: { state: 'done' } }).deps.s3, 'logs')).toEqual({ state: 'done' });
  });
});

describe('reads each log file once', () => {
  const zlib = require('zlib');
  const { COLUMNS } = require('../lambda/dashboard/logfile');
  const line = (values) => COLUMNS.map((name) => values[name] ?? '-').join('\t');
  const BROWSER = 'Mozilla/5.0%20(Macintosh)';
  const logFile = (requests) => zlib.gzipSync(`#Version: 1.0\n#Fields: ${COLUMNS.join(' ')}\n${requests.map(([ip, path, time = '10:00:00', extra = {}]) => line({
    date: '2026-10-09', time, 'c-ip': ip, 'cs-uri-stem': path, 'cs(User-Agent)': BROWSER, asn: '3320', ...extra,
  })).join('\n')}\n`);
  const later = NOW + 6 * 60 * 60 * 1000;

  test('a second run reads only new files, adds them to the counts and looks no IP up twice', async () => {
    const t = setup(null, {
      objects: {
        'logs/site=root/dt=2026-10-09/a.gz': logFile([['192.0.2.1', '/'], ['192.0.2.2', '/'], ['192.0.2.3', '/wp-login.php']]),
        'logs/site=cyy/dt=2026-10-08/b.gz': logFile([['192.0.2.4', '/'], ['192.0.2.4', '/app.js']]),
        'logs/site=other/dt=2026-10-09/x.gz': logFile([['192.0.2.9', '/']]),
        'logs/site=root/dt=2026-10-05/old.gz': logFile([['192.0.2.8', '/']]),
      },
    });
    t.deps.runQuery = async (sql) => { t.queries.push(sql); return [{ ip: '192.0.2.2', score: '0', usage_type: 'Fixed Line ISP', is_tor: 'false', checked: '2026-10-01T00:00:00Z' }]; };
    t.deps.fetchImpl = async (url) => { t.lookups.push(new URL(url).searchParams.get('ipAddress')); return response(200, abuse(0)); };
    const first = await bots.update({}, t.deps);

    // 192.0.2.1 and .2 loaded no page file: headless, so not looked up; .3 is a scanner; .4 is a person.
    expect(first).toMatchObject({ files_read: 2, ips: 4, bots: { probe: 1, headless: 2 } });
    expect(t.lookups).toEqual(['192.0.2.4']);
    expect(t.queries).toHaveLength(1);
    expect(t.gets.filter((key) => key.startsWith('logs/'))).toEqual(expect.arrayContaining(['logs/site=root/dt=2026-10-09/a.gz', 'logs/site=cyy/dt=2026-10-08/b.gz']));
    expect(t.gets).not.toContain('logs/site=other/dt=2026-10-09/x.gz');
    expect(t.gets).not.toContain('logs/site=root/dt=2026-10-05/old.gz');
    // One list per site for all 4 days.
    expect(t.lists.filter((prefix) => prefix.startsWith('logs/'))).toEqual(['logs/site=root/dt=', 'logs/site=cyy/dt=']);
    const state = JSON.parse(t.store.get('bot-state/dt=2026-10-09.json'));
    expect(state.files).toEqual(['logs/site=root/dt=2026-10-09/a.gz']);
    expect(state.ips['192.0.2.3']).toEqual([1, 1, '3320', '2026-10-09T10:00:00Z', 1, 0]);
    expect(Object.keys(JSON.parse(t.store.get(bots.REPUTATION_CACHE_KEY)).ips).sort()).toEqual(['192.0.2.2', '192.0.2.4']);

    // New requests: .1 now loads a script (a person, looked up), .4 comes back (already looked up).
    t.store.set('logs/site=root/dt=2026-10-09/c.gz', logFile([['192.0.2.1', '/app.js', '16:00:00', { asn: '2856' }], ['192.0.2.4', '/'], ['192.0.2.4', '/x.css']]));
    t.gets.length = 0;
    const second = await bots.update({}, { ...t.deps, now: later });
    expect(t.gets.filter((key) => key.startsWith('logs/'))).toEqual(['logs/site=root/dt=2026-10-09/c.gz']);
    expect(second).toMatchObject({ files_read: 1, bots: { probe: 1, headless: 1 } });
    expect(t.lookups).toEqual(['192.0.2.4', '192.0.2.1']);
    expect(t.queries).toHaveLength(1);
    const updated = JSON.parse(t.store.get('bot-state/dt=2026-10-09.json'));
    expect(updated.files).toEqual(['logs/site=root/dt=2026-10-09/a.gz', 'logs/site=root/dt=2026-10-09/c.gz']);
    expect(updated.ips['192.0.2.1']).toEqual([2, 2, '2856', '2026-10-09T16:00:00Z', 0, 1]);
    expect(t.file('bots/dt=2026-10-09/bots.json')).toEqual([{ ip: '192.0.2.2', reason: 'headless' }, { ip: '192.0.2.3', reason: 'probe' }]);

    // Nothing new: no log file read, no lookup.
    t.gets.length = 0;
    expect(await bots.update({}, { ...t.deps, now: later + 60000 })).toMatchObject({ files_read: 0 });
    expect(t.gets.filter((key) => key.startsWith('logs/'))).toEqual([]);
    expect(t.lookups).toHaveLength(2);
  });

  test('a run that fails before saving reads the same files again next time', async () => {
    const t = setup(null, { objects: { 'logs/site=root/dt=2026-10-09/a.gz': logFile([['192.0.2.1', '/app.js']]) } });
    t.deps.loadHosting = async () => { throw new Error('hosting list unreadable'); };
    await expect(bots.update({}, t.deps)).rejects.toThrow();
    expect(t.store.has('bot-state/dt=2026-10-09.json')).toBe(false);
    t.deps.loadHosting = async () => NETWORKS;
    expect(await bots.update({}, { ...t.deps, now: NOW + 60 * 60 * 1000 })).toMatchObject({ files_read: 1, ips: 1 });
  });

  test('crawler user agents, decoded paths and the visitor cookie count like the dashboard', () => {
    const state = require('../lambda/dashboard/bot-state');
    const { parseLog } = require('../lambda/dashboard/logfile');
    const ips = {};
    const rows = parseLog(`#Fields: ${COLUMNS.join(' ')}\n${[
      line({ date: '2026-10-09', time: '01:00:00', 'c-ip': '192.0.2.1', 'cs-uri-stem': '/%2Eenv', 'cs(User-Agent)': 'curl/8.0' }),
      line({ date: '2026-10-09', time: '02:00:00', 'c-ip': '192.0.2.2', 'cs-uri-stem': '/', 'cs(User-Agent)': BROWSER, 'cs(Cookie)': 'dl_vid%3Dabcdef1234' }),
    ].join('\n')}\n`);
    state.addRows(ips, rows, new RegExp(bots.PROBE), new RegExp(bots.PAGE_FILE));
    expect(ips['192.0.2.1']).toEqual([1, 0, null, null, 1, 0]);
    expect(ips['192.0.2.2']).toEqual([1, 1, null, null, 0, 1]);
  });
});
