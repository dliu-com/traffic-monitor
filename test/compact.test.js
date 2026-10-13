const zlib = require('zlib');
const compact = require('../lambda/dashboard/compact');
const { OUTPUT_FIELDS } = require('../lambda/partitioner');
const { STATUS_KEY } = require('../lambda/dashboard/bots');

const NOW = Date.UTC(2026, 9, 13, 1, 30, 0);
const env = { SITES: 'root=dliu.com,cyy=cyy.dliu.com' };
const DONE_TODAY = { state: 'done', trigger: 'schedule', started: '2026-10-13T00:30:00.000Z', finished: '2026-10-13T00:31:10.000Z' };

const BROWSER = 'Mozilla/5.0%20(Macintosh;%20Intel%20Mac%20OS%20X%2010_15_7)%20AppleWebKit/605.1.15';
function line(values) {
  return compact.COLUMNS.map((name) => (name in values ? values[name] : 'x')).join('\t');
}
const v2File = (rows) => zlib.gzipSync(`#Version: 1.0\n#Fields: ${compact.COLUMNS.join(' ')}\n${rows.map((r) => `${line(r)}\n`).join('')}`);
const LEGACY = compact.COLUMNS.slice(0, 33);
const legacyFile = (rows) => zlib.gzipSync(`#Version: 1.0\n#Fields: ${LEGACY.join(' ')}\n${rows.map((r) => `${LEGACY.map((n) => (n in r ? r[n] : 'x')).join('\t')}\n`).join('')}`);
const req = (id, ip, ua = BROWSER) => ({ 'x-edge-request-id': id, 'c-ip': ip, 'cs(User-Agent)': ua });

// A fake S3 bucket: a map of key -> Buffer, recording every call.
function bucket(objects) {
  const store = new Map(Object.entries(objects).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)]));
  const calls = [];
  const send = async (command) => {
    const name = command.constructor.name;
    const input = command.input;
    calls.push({ name, input });
    if (name === 'ListObjectsV2Command') {
      return { Contents: [...store.keys()].filter((k) => k.startsWith(input.Prefix)).sort().map((Key) => ({ Key })), IsTruncated: false };
    }
    if (name === 'GetObjectCommand') {
      if (!store.has(input.Key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      const body = store.get(input.Key);
      return { Body: { transformToByteArray: async () => new Uint8Array(body), transformToString: async () => body.toString('utf8') } };
    }
    if (name === 'PutObjectCommand') {
      store.set(input.Key, Buffer.from(input.Body));
      return {};
    }
    if (name === 'DeleteObjectsCommand') {
      for (const { Key } of input.Delete.Objects) store.delete(Key);
      return {};
    }
    throw new Error(`unexpected ${name}`);
  };
  return { store, calls, client: { send } };
}

const rowsOf = (buffer) => zlib.gunzipSync(buffer).toString('utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
const deps = (b) => ({ s3: b.client, bucket: 'logs', env, now: NOW });

beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

test('the column list matches the partitioner output', () => {
  expect(compact.COLUMNS).toEqual(OUTPUT_FIELDS);
});

describe('which days are merged', () => {
  test('the newest 3 days stay complete; the 4 days before them are merged', () => {
    expect(compact.daysToMerge({}, NOW, DONE_TODAY)).toEqual(['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
  });

  test('nothing is merged unless the last bot check finished', () => {
    expect(compact.daysToMerge({}, NOW, null)).toEqual([]);
    expect(compact.daysToMerge({}, NOW, { ...DONE_TODAY, state: 'running' })).toEqual([]);
    expect(compact.daysToMerge({}, NOW, { ...DONE_TODAY, state: 'failed' })).toEqual([]);
  });

  test('an older bot check only allows days it finished judging', () => {
    // Last finished check started on 10-11: its last pass covered 10-08, so 10-09 must wait.
    expect(compact.daysToMerge({}, NOW, { ...DONE_TODAY, started: '2026-10-11T00:30:00Z' })).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  });

  test('a backfill takes from/to, capped at the newest mergeable day', () => {
    expect(compact.daysToMerge({ from: '2026-10-08', to: '2026-10-20' }, NOW, DONE_TODAY)).toEqual(['2026-10-08', '2026-10-09']);
    expect(() => compact.daysToMerge({ from: 'x', to: '2026-10-01' }, NOW, DONE_TODAY)).toThrow();
    expect(() => compact.daysToMerge({ from: '2025-01-01', to: '2026-10-01' }, NOW, DONE_TODAY)).toThrow(/400/);
  });
});

test('bots are agents by user agent (as the dashboard) or by that day\'s verdict', () => {
  for (const ua of ['-', '', 'curl/8.1', 'Mozilla/5.0%20(compatible;%20Googlebot/2.1)', 'python-requests/2.31', 'Go-http-client/1.1']) {
    expect(compact.isAgent(ua)).toBe(true);
  }
  expect(compact.isAgent(BROWSER)).toBe(false);
  expect(compact.isAgent('%E0%A4%A')).toBe(false);
  const rows = [req('a', '192.0.2.1'), req('b', '192.0.2.2'), req('a', '192.0.2.1'), req('c', '192.0.2.3', 'curl/8')]
    .map((r) => compact.parseLog(`${line(r)}\n`)[0]);
  const result = compact.mergeRows([rows], new Set(['192.0.2.2']));
  expect(result).toMatchObject({ bots: 2, duplicates: 1 });
  expect(result.kept.map((r) => r[compact.COLUMNS.indexOf('c-ip')])).toEqual(['192.0.2.1']);
});

test('merges a day per site into a monthly archive folder, drops bots and deletes the old files after writing', async () => {
  const b = bucket({
    [STATUS_KEY]: JSON.stringify(DONE_TODAY),
    'bots/dt=2026-10-09/bots.json': '{"ip":"192.0.2.66","reason":"abuse"}\n',
    'bots/dt=2026-10-08/bots.json': '',
    'logs/site=root/dt=2026-10-09/v2-a.gz': v2File([req('r1', '192.0.2.1'), req('r2', '192.0.2.66'), req('r3', '192.0.2.5', 'Googlebot')]),
    'logs/site=root/dt=2026-10-09/E1.2026-10-09-01.x.gz': legacyFile([req('r4', '192.0.2.7'), req('r1', '192.0.2.1')]),
    'logs/site=root/dt=2026-10-10/v2-new.gz': v2File([req('n1', '192.0.2.66')]),
    'logs/site=cyy/dt=2026-10-08/v2-b.gz': v2File([req('c1', '192.0.2.9')]),
  });
  const result = await compact.update({}, deps(b));
  expect(result).toMatchObject({ days: ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'], unjudged: ['2026-10-06', '2026-10-07'], kept: 3, bots: 2, duplicates: 1, files: 3 });

  const root = rowsOf(b.store.get('archive/month=2026-10/root_2026-10-09.gz'));
  expect(root.map((r) => r[compact.COLUMNS.indexOf('c-ip')]).sort()).toEqual(['192.0.2.1', '192.0.2.7']);
  expect(root.every((r) => r.length === 38)).toBe(true);
  // site and dt are added as the last two columns, since the archive folder only names the month.
  expect(root.every((r) => r[36] === 'root' && r[37] === '2026-10-09')).toBe(true);
  // Legacy rows get '-' for the 3 added columns; everything else is copied unchanged.
  const legacy = root.find((r) => r[compact.COLUMNS.indexOf('c-ip')] === '192.0.2.7');
  expect(legacy.slice(33, 36)).toEqual(['-', '-', '-']);
  expect(legacy[compact.COLUMNS.indexOf('cs(User-Agent)')]).toBe(BROWSER);
  expect(zlib.gunzipSync(b.store.get('archive/month=2026-10/root_2026-10-09.gz')).toString().startsWith(compact.HEADER)).toBe(true);

  // Only the merged folders' own files are gone; the newest days are untouched.
  expect([...b.store.keys()].filter((k) => k.startsWith('logs/') || k.startsWith('archive/')).sort()).toEqual([
    'archive/month=2026-10/cyy_2026-10-08.gz',
    'archive/month=2026-10/root_2026-10-09.gz',
    'logs/site=root/dt=2026-10-10/v2-new.gz',
  ]);
  expect(compact.archiveKey('root', '2026-09-30')).toBe('archive/month=2026-09/root_2026-09-30.gz');
  const put = b.calls.findIndex((c) => c.name === 'PutObjectCommand' && c.input.Key === 'archive/month=2026-10/root_2026-10-09.gz');
  const del = b.calls.findIndex((c) => c.name === 'DeleteObjectsCommand' && c.input.Delete.Objects.some((o) => o.Key.startsWith('logs/site=root/dt=2026-10-09/')));
  expect(put).toBeGreaterThan(-1);
  expect(put).toBeLessThan(del);
  expect(b.calls.find((c) => c.name === 'DeleteObjectsCommand' && c.input.Delete.Objects.some((o) => o.Key.startsWith('archive/')))).toBeUndefined();
});

test('a rerun is a no-op, and a late file is merged in without double counting', async () => {
  const b = bucket({
    [STATUS_KEY]: JSON.stringify(DONE_TODAY),
    'bots/dt=2026-10-09/bots.json': '',
    'logs/site=root/dt=2026-10-09/v2-a.gz': v2File([req('r1', '192.0.2.1')]),
  });
  await compact.update({}, deps(b));
  const puts = () => b.calls.filter((c) => c.name === 'PutObjectCommand').length;
  expect(puts()).toBe(1);
  await compact.update({}, deps(b));
  expect(puts()).toBe(1);
  // A crash after writing the archive file leaves the old file behind; it is merged again, de-duplicated.
  b.store.set('logs/site=root/dt=2026-10-09/v2-a.gz', v2File([req('r1', '192.0.2.1')]));
  b.store.set('logs/site=root/dt=2026-10-09/v2-late.gz', v2File([req('r9', '192.0.2.9')]));
  const result = await compact.update({}, deps(b));
  expect(result).toMatchObject({ kept: 2, duplicates: 1 });
  expect(rowsOf(b.store.get('archive/month=2026-10/root_2026-10-09.gz'))).toHaveLength(2);
  expect([...b.store.keys()].filter((k) => k.startsWith('logs/') || k.startsWith('archive/'))).toEqual(['archive/month=2026-10/root_2026-10-09.gz']);
});

test('nothing changes while the bot check is running, and a dry run writes nothing', async () => {
  const objects = {
    [STATUS_KEY]: JSON.stringify({ ...DONE_TODAY, state: 'running' }),
    'bots/dt=2026-10-09/bots.json': '',
    'logs/site=root/dt=2026-10-09/v2-a.gz': v2File([req('r1', '192.0.2.1')]),
  };
  const running = bucket(objects);
  expect(await compact.update({}, deps(running))).toMatchObject({ merged: [], skipped: 'bot check not finished' });
  expect(running.calls.some((c) => ['PutObjectCommand', 'DeleteObjectsCommand'].includes(c.name))).toBe(false);

  const dry = bucket({ ...objects, [STATUS_KEY]: JSON.stringify(DONE_TODAY) });
  expect(await compact.update({ dryRun: true }, deps(dry))).toMatchObject({ dryRun: true, kept: 1 });
  expect(dry.calls.some((c) => ['PutObjectCommand', 'DeleteObjectsCommand'].includes(c.name))).toBe(false);
});

test('a backfill can merge days without verdicts (before the bot check), dropping agent bots only', async () => {
  const objects = {
    [STATUS_KEY]: JSON.stringify(DONE_TODAY),
    'logs/site=root/dt=2026-09-01/v2-a.gz': v2File([req('r1', '192.0.2.1'), req('r2', '192.0.2.2', 'curl/8')]),
  };
  const plain = bucket(objects);
  expect(await compact.update({ from: '2026-09-01', to: '2026-09-01' }, deps(plain))).toMatchObject({ unjudged: ['2026-09-01'], merged: [] });
  expect(plain.store.has('logs/site=root/dt=2026-09-01/v2-a.gz')).toBe(true);

  const b = bucket(objects);
  expect(await compact.update({ from: '2026-09-01', to: '2026-09-01', unjudged: 'agents' }, deps(b))).toMatchObject({ unjudged: [], kept: 1, bots: 1 });
  expect(rowsOf(b.store.get('archive/month=2026-09/root_2026-09-01.gz')).map((r) => r[compact.COLUMNS.indexOf('c-ip')])).toEqual(['192.0.2.1']);
  // The daily run never merges unjudged days, even if asked.
  const daily = bucket({ ...objects, 'logs/site=root/dt=2026-10-09/v2-b.gz': v2File([req('d1', '192.0.2.1')]) });
  expect(await compact.update({ unjudged: 'agents' }, deps(daily))).toMatchObject({ unjudged: ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'] });
});
