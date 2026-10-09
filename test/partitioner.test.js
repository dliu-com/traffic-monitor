const { CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { handler, targetKey, decodeKey } = require('../lambda/partitioner');

describe('log partitioner', () => {
  test('maps CloudFront log keys to partitioned keys', () => {
    expect(targetKey('raw/xiangqi/E2ABCDEF.2026-10-09-01.a1b2c3d4.gz'))
      .toBe('logs/site=xiangqi/dt=2026-10-09/E2ABCDEF.2026-10-09-01.a1b2c3d4.gz');
  });

  test('rejects unexpected keys', () => {
    expect(targetKey('raw/xiangqi/notes.txt')).toBeNull();
    expect(targetKey('logs/site=x/dt=2026-01-01/E.2026-01-01-00.a.gz')).toBeNull();
    expect(targetKey('raw/a/b/E.2026-01-01-00.a.gz')).toBeNull();
  });

  test('decodes S3 event keys', () => {
    expect(decodeKey('raw/cyy/a+b%2Bc.gz')).toBe('raw/cyy/a b+c.gz');
  });

  test('copies then deletes each record', async () => {
    const sent = [];
    const s3 = { send: async (command) => { sent.push(command); return {}; } };
    await handler({
      Records: [
        { s3: { bucket: { name: 'logs-bucket' }, object: { key: 'raw/cyy/E1.2026-10-09-23.abc.gz' } } },
        { s3: { bucket: { name: 'logs-bucket' }, object: { key: 'raw/cyy/ignore.txt' } } },
      ],
    }, {}, s3);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBeInstanceOf(CopyObjectCommand);
    expect(sent[0].input).toEqual({
      Bucket: 'logs-bucket',
      Key: 'logs/site=cyy/dt=2026-10-09/E1.2026-10-09-23.abc.gz',
      CopySource: 'logs-bucket/raw/cyy/E1.2026-10-09-23.abc.gz',
    });
    expect(sent[1]).toBeInstanceOf(DeleteObjectCommand);
    expect(sent[1].input).toEqual({ Bucket: 'logs-bucket', Key: 'raw/cyy/E1.2026-10-09-23.abc.gz' });
  });
});
