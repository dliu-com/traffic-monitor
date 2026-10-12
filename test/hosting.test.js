const hosting = require('../lambda/dashboard/hosting');

const { BUILT_IN, EXCLUDED, KEY, SOURCES, cleanName, loadHosting, merge, parseAsnComment, parseCsv, resetCache, update, validAsn } = hosting;

const many = (from, count, format) => Array.from({ length: count }, (_, i) => (format === 'csv' ? `${from + i},"Host ${i}"` : `AS${from + i} # Host ${i}`)).join('\n');

describe('parsing', () => {
  test('csv list (brianhama)', () => {
    expect(parseCsv('ASN,Entity\n1442,"Surehosting Internet Solutions, Inc."\n3223,"Voxility, Ro"\nnope,"x"\n99999999999,"too big"\n'))
      .toEqual({ 1442: 'Surehosting Internet Solutions, Inc.', 3223: 'Voxility, Ro' });
  });

  test('ASN-with-comment list (X4BNet)', () => {
    expect(parseAsnComment('AS45090 # Tencent cloud computing\nAS3223 # VOXILITY, RO\nAS36183 # Akami AS - https://asn.ipinfo.app/AS36183\n# comment\nASx1\nAS7'))
      .toEqual({ 45090: 'Tencent cloud computing', 3223: 'VOXILITY, RO', 36183: 'Akami AS', 7: '' });
  });

  test('names are plain text and ASNs are numbers in range', () => {
    expect(cleanName("<script>alert('x')</script> Evil'; DROP TABLE--")).toBe("script alert('x') /script Evil' DROP TABLE");
    expect(cleanName('x'.repeat(100))).toHaveLength(60);
    expect([validAsn('AS15169'), validAsn(' 8075 '), validAsn('0'), validAsn('4294967296'), validAsn("1' OR 1=1"), validAsn('1e3')])
      .toEqual([15169, 8075, null, null, null, null]);
  });
});

describe('merge', () => {
  test('built-in names win, excluded networks never appear', () => {
    const networks = merge([{ 16509: 'AMAZON-02', 13335: 'Cloudflare', 714: 'Apple', 64500: 'Example' }, { 64500: 'Other', 64501: '' }]);
    expect(networks[16509]).toBe('Amazon AWS');
    expect(networks[64500]).toBe('Example');
    expect(networks[64501]).toBe('AS64501');
    for (const asn of Object.keys(EXCLUDED)) expect(networks).not.toHaveProperty(asn);
    for (const asn of Object.keys(BUILT_IN)) expect(networks).toHaveProperty(asn);
  });
});

describe('weekly update', () => {
  const puts = [];
  const s3 = { send: async (command) => { puts.push(command.input); return {}; } };
  const bodies = { csv: `ASN,Entity\n${many(100000, 250, 'csv')}`, 'asn-comment': many(200000, 250, 'asn') };
  const fetchFor = (overrides = {}) => async (url) => {
    const source = SOURCES.find((s) => s.url === url);
    const body = Object.hasOwn(overrides, source.format) ? overrides[source.format] : bodies[source.format];
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, text: async () => body };
  };

  beforeEach(() => { puts.length = 0; });

  test('merges both lists and saves them', async () => {
    const result = await update({}, { fetchImpl: fetchFor(), s3, bucket: 'b', now: Date.UTC(2026, 9, 12) });
    expect(result.total).toBe(500 + Object.keys(BUILT_IN).length);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ Bucket: 'b', Key: KEY, ContentType: 'application/json' });
    const saved = JSON.parse(puts[0].Body);
    expect(saved.updated).toBe('2026-10-12T00:00:00.000Z');
    expect(saved.sources).toEqual({ 'brianhama/bad-asn-list': 250, 'X4BNet/lists_vpn': 250 });
  });

  test('a failing or tiny source is skipped', async () => {
    const result = await update({}, { fetchImpl: fetchFor({ csv: new Error('down'), 'asn-comment': many(300000, 400, 'asn') }), s3, bucket: 'b' });
    expect(Object.keys(JSON.parse(puts[0].Body).sources)).toEqual(['X4BNet/lists_vpn']);
    expect(result.total).toBe(400 + Object.keys(BUILT_IN).length);
  });

  test('nothing is written when the result looks wrong', async () => {
    await expect(update({}, { fetchImpl: fetchFor({ csv: 'ASN,Entity\n1,"x"', 'asn-comment': new Error('down') }), s3, bucket: 'b' })).rejects.toThrow('keeping the last copy');
    await expect(update({}, { fetchImpl: fetchFor({ csv: many(1, 210, 'csv'), 'asn-comment': '' }), s3, bucket: 'b' })).rejects.toThrow('only');
    expect(puts).toHaveLength(0);
  });
});

describe('dashboard loader', () => {
  const stored = (body) => ({ send: jest.fn(async () => ({ Body: { transformToString: async () => body } })) });

  beforeEach(() => resetCache());

  test('reads the S3 copy once an hour and re-applies exclusions', async () => {
    const s3 = stored(JSON.stringify({ networks: { 64500: 'Example', 13335: 'Cloudflare', bad: 'x' } }));
    const first = await loadHosting({ s3, bucket: 'b', now: 0 });
    expect(first[64500]).toBe('Example');
    expect(first).not.toHaveProperty('13335');
    expect(first).not.toHaveProperty('bad');
    expect(first[8075]).toBe('Microsoft Azure');
    await loadHosting({ s3, bucket: 'b', now: 59 * 60 * 1000 });
    expect(s3.send).toHaveBeenCalledTimes(1);
    await loadHosting({ s3, bucket: 'b', now: 61 * 60 * 1000 });
    expect(s3.send).toHaveBeenCalledTimes(2);
  });

  test('falls back to the built-in list', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadHosting({ s3: stored('not json'), bucket: 'b', now: 0 })).toEqual(merge([]));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    resetCache();
    expect(await loadHosting({ bucket: '' })).toEqual(merge([]));
  });
});
