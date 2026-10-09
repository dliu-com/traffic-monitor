const zlib = require('zlib');
const { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { handler, processEvent, targetKey, decodeKey, normalizeV2, isRetiredLegacy, OUTPUT_FIELDS, LEGACY_LAST_HOUR } = require('../lambda/partitioner');
const FIELDS = require('../lambda/partitioner/fields.json');

// A v2 line with every legacy field set to "<name>" plus the three added fields.
function v2Line(values) {
  return OUTPUT_FIELDS.map((name) => (name in values ? values[name] : name)).join('\t');
}

describe('log partitioner', () => {
  test('maps CloudFront log keys to partitioned keys', () => {
    expect(targetKey('raw/xiangqi/E2ABCDEF.2026-10-09-01.a1b2c3d4.gz'))
      .toBe('logs/site=xiangqi/dt=2026-10-09/E2ABCDEF.2026-10-09-01.a1b2c3d4.gz');
  });

  test('rejects unexpected keys', () => {
    expect(targetKey('raw/xiangqi/notes.txt')).toBeNull();
    expect(targetKey('logs/site=x/dt=2026-01-01/E.2026-01-01-00.a.gz')).toBeNull();
    expect(targetKey('raw/a/b/E.2026-01-01-00.a.gz')).toBeNull();
    expect(targetKey('raw-v2/cyy/2026/10/09')).toBeNull();
    expect(targetKey('raw-v2/cyy/2026/10/9/a.gz')).toBeNull();
    expect(targetKey('raw-v2/Cyy/2026/10/09/a.gz')).toBeNull();
    expect(targetKey('raw-v2/cyy/2026/10/09/../a.gz')).toBeNull();
  });

  test('maps v2 log keys to partitioned keys', () => {
    expect(targetKey('raw-v2/weiqi/2026/10/09/EABC.2026-10-09-21.f00d.gz'))
      .toBe('logs/site=weiqi/dt=2026-10-09/v2-EABC.2026-10-09-21.f00d.gz');
    expect(targetKey('raw-v2/weiqi/2026/10/09/abc.log')).toBe('logs/site=weiqi/dt=2026-10-09/v2-abc.log.gz');
  });

  test('lambda entry point is not callback-style', () => {
    expect(handler.length).toBe(1);
    expect(require('../lambda/dashboard').handler.length).toBeLessThanOrEqual(1);
  });

  test('decodes S3 event keys', () => {
    expect(decodeKey('raw/cyy/a+b%2Bc.gz')).toBe('raw/cyy/a b+c.gz');
  });

  test('copies then deletes each record', async () => {
    const sent = [];
    const s3 = { send: async (command) => { sent.push(command); return {}; } };
    await processEvent({
      Records: [
        { s3: { bucket: { name: 'logs-bucket' }, object: { key: 'raw/cyy/E1.2026-10-09-21.abc.gz' } } },
        { s3: { bucket: { name: 'logs-bucket' }, object: { key: 'raw/cyy/ignore.txt' } } },
      ],
    }, s3);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBeInstanceOf(CopyObjectCommand);
    expect(sent[0].input).toEqual({
      Bucket: 'logs-bucket',
      Key: 'logs/site=cyy/dt=2026-10-09/E1.2026-10-09-21.abc.gz',
      CopySource: 'logs-bucket/raw/cyy/E1.2026-10-09-21.abc.gz',
    });
    expect(sent[1]).toBeInstanceOf(DeleteObjectCommand);
    expect(sent[1].input).toEqual({ Bucket: 'logs-bucket', Key: 'raw/cyy/E1.2026-10-09-21.abc.gz' });
  });

  test('discards legacy logs for hours that v2 covers', async () => {
    expect(LEGACY_LAST_HOUR).toBe('2026-10-09-21');
    expect(isRetiredLegacy('raw/cyy/E1.2026-10-09-21.abc.gz')).toBe(false);
    expect(isRetiredLegacy('raw/cyy/E1.2026-10-08-23.abc.gz')).toBe(false);
    expect(isRetiredLegacy('raw/cyy/E1.2026-10-09-22.abc.gz')).toBe(true);
    expect(isRetiredLegacy('raw/cyy/E1.2027-01-01-00.abc.gz')).toBe(true);
    expect(isRetiredLegacy('raw-v2/cyy/2026/10/10/E1.2026-10-10-00.abc.gz')).toBe(false);
    const sent = [];
    const s3 = { send: async (command) => { sent.push(command); return {}; } };
    await processEvent({ Records: [{ s3: { bucket: { name: 'b' }, object: { key: 'raw/cyy/E1.2026-10-10-00.abc.gz' } } }] }, s3);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(sent[0].input).toEqual({ Bucket: 'b', Key: 'raw/cyy/E1.2026-10-10-00.abc.gz' });
  });

  test('rewrites v2 files into the table column order', () => {
    expect(OUTPUT_FIELDS).toEqual([...FIELDS.legacy, ...FIELDS.added]);
    expect(FIELDS.legacy).toHaveLength(33);
    const shuffled = ['viewer-response-log-data', 'c-ip', 'c-country', 'date', 'asn'];
    const text = [
      '#Version: 1.0',
      `#Fields: ${shuffled.join(' ')}`,
      ['abc123def456', '203.0.113.9', 'JP', '2026-10-09', '2516'].join('\t'),
      ['-', '2001:db8::1', '', '2026-10-09', '-'].join('\t'),
      '',
    ].join('\r\n');
    const lines = normalizeV2(text).split('\n');
    expect(lines[0]).toBe('#Version: 1.0');
    expect(lines[1]).toBe(`#Fields: ${OUTPUT_FIELDS.join(' ')}`);
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe('');
    const row = lines[2].split('\t');
    expect(row).toHaveLength(36);
    expect(row[0]).toBe('2026-10-09');
    expect(row[4]).toBe('203.0.113.9');
    expect(row[1]).toBe('-');
    expect(row.slice(33)).toEqual(['JP', '2516', 'abc123def456']);
    expect(lines[3].split('\t').slice(33)).toEqual(['-', '-', '-']);
  });

  test('uses the configured field order when a v2 file has no header', () => {
    const line = v2Line({ 'c-country': 'GB', asn: '16509' });
    expect(normalizeV2(`${line}\n`).split('\n')[2]).toBe(line);
  });

  test('converts each v2 file, writes it to its partition, then deletes it', async () => {
    const sent = [];
    const raw = zlib.gzipSync(`#Fields: ${OUTPUT_FIELDS.join(' ')}\n${v2Line({ 'c-country': 'FR' })}\n`);
    const s3 = {
      send: async (command) => {
        sent.push(command);
        if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => raw } };
        return {};
      },
    };
    await processEvent({
      Records: [{ s3: { bucket: { name: 'logs-bucket' }, object: { key: 'raw-v2/root/2026/10/09/E1.2026-10-09-21.x.gz' } } }],
    }, s3);
    expect(sent.map((c) => c.constructor)).toEqual([GetObjectCommand, PutObjectCommand, DeleteObjectCommand]);
    expect(sent[1].input.Key).toBe('logs/site=root/dt=2026-10-09/v2-E1.2026-10-09-21.x.gz');
    const written = zlib.gunzipSync(sent[1].input.Body).toString('utf8').split('\n');
    expect(written[2].split('\t')[33]).toBe('FR');
    expect(sent[2].input.Key).toBe('raw-v2/root/2026/10/09/E1.2026-10-09-21.x.gz');
  });

  test('accepts uncompressed v2 files', async () => {
    const sent = [];
    const raw = Buffer.from(`${v2Line({ asn: '3320' })}\n`);
    const s3 = {
      send: async (command) => {
        sent.push(command);
        return command instanceof GetObjectCommand ? { Body: { transformToByteArray: async () => raw } } : {};
      },
    };
    await processEvent({ Records: [{ s3: { bucket: { name: 'b' }, object: { key: 'raw-v2/cyy/2026/10/09/plain.log' } } }] }, s3);
    expect(zlib.gunzipSync(sent[1].input.Body).toString('utf8').split('\n')[2].split('\t')[34]).toBe('3320');
  });
});

describe('overlap de-duplication script', () => {
  const { withoutSeen, REQUEST_ID } = require('../scripts/dedupe-overlap');

  test('uses the request ID column', () => {
    expect(FIELDS.legacy[REQUEST_ID]).toBe('x-edge-request-id');
    expect(OUTPUT_FIELDS[REQUEST_ID]).toBe('x-edge-request-id');
  });

  test('drops only rows whose request ID was seen, keeping headers', () => {
    const row = (id) => FIELDS.legacy.map((name, i) => (i === REQUEST_ID ? id : name)).join('\t');
    const text = `#Version: 1.0\n#Fields: x\n${row('a')}\n${row('b')}\n`;
    const { text: out, dropped } = withoutSeen(text, new Set(['a']));
    expect(dropped).toBe(1);
    expect(out).toBe(`#Version: 1.0\n#Fields: x\n${row('b')}\n`);
    expect(withoutSeen(out, new Set(['a'])).dropped).toBe(0);
  });
});
