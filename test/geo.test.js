const zlib = require('zlib');
const geo = require('../lambda/dashboard/geo');

// ---------- A tiny MaxMind DB writer, enough to build test databases ----------
function control(type, size) {
  const head = [];
  let sizeBits = size;
  const extra = [];
  if (size >= 29) {
    sizeBits = 29;
    extra.push(size - 29);
  }
  if (type <= 7) head.push((type << 5) | sizeBits);
  else head.push(sizeBits, type - 7);
  return Buffer.from([...head, ...extra]);
}

function encode(value) {
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([control(2, bytes.length), bytes]);
  }
  if (typeof value === 'boolean') return control(14, value ? 1 : 0);
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    const bytes = [];
    for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
    return Buffer.concat([control(6, bytes.length), Buffer.from(bytes)]);
  }
  if (typeof value === 'number') {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    return Buffer.concat([control(3, 8), bytes]);
  }
  if (Array.isArray(value)) return Buffer.concat([control(11, value.length), ...value.map(encode)]);
  if (value && value.pointer !== undefined) return Buffer.from([(1 << 5) | (value.pointer >> 8), value.pointer & 0xff]);
  const entries = Object.entries(value);
  return Buffer.concat([control(7, entries.length), ...entries.flatMap(([k, v]) => [encode(k), encode(v)])]);
}

const bitsOf = (ip, prefix) => {
  const bytes = geo.ipBytes(ip);
  const full = bytes.length === 4 ? Buffer.concat([Buffer.alloc(12), bytes]) : bytes;
  const extra = bytes.length === 4 ? 96 : 0;
  return Array.from({ length: prefix + extra }, (_, i) => (full[i >> 3] >> (7 - (i & 7))) & 1);
};

// networks: [[ip, prefix length, record]]; IPv4 networks are stored under ::/96 like DB-IP's.
function buildDb(networks, { recordSize = 24, type = 'DBIP-City-Lite', shared } = {}) {
  const nodes = [[null, null]];
  const chunks = [];
  let dataSize = 0;
  const addData = (value) => {
    const bytes = encode(value);
    const offset = dataSize;
    chunks.push(bytes);
    dataSize += bytes.length;
    return offset;
  };
  // An optional value at data offset 0, for records to point to.
  if (shared) addData(shared);
  for (const [ip, prefix, record] of networks) {
    const bits = bitsOf(ip, prefix);
    const data = { data: addData(record) };
    let node = 0;
    bits.forEach((bit, i) => {
      if (i === bits.length - 1) nodes[node][bit] = data;
      else {
        if (typeof nodes[node][bit] !== 'number') {
          nodes.push([null, null]);
          nodes[node][bit] = nodes.length - 1;
        }
        node = nodes[node][bit];
      }
    });
  }
  const count = nodes.length;
  const value = (r) => (r === null ? count : typeof r === 'number' ? r : count + 16 + r.data);
  const tree = Buffer.alloc((count * recordSize * 2) / 8);
  nodes.forEach(([left, right], n) => {
    const l = value(left);
    const r = value(right);
    if (recordSize === 24) {
      tree.writeUIntBE(l, n * 6, 3);
      tree.writeUIntBE(r, n * 6 + 3, 3);
    } else {
      const o = n * 7;
      tree.writeUIntBE(l & 0xffffff, o, 3);
      tree[o + 3] = ((l >> 24) << 4) | (r >> 24);
      tree.writeUIntBE(r & 0xffffff, o + 4, 3);
    }
  });
  const metadata = encode({ node_count: count, record_size: recordSize, ip_version: 6, database_type: type, binary_format_major_version: 2, build_epoch: 1793491200 });
  return Buffer.concat([tree, Buffer.alloc(16), ...chunks, Buffer.from('abcdef4d61784d696e642e636f6d', 'hex'), metadata]);
}

const place = (country, city) => ({ city: { names: { en: city } }, country: { iso_code: country, is_in_european_union: false }, location: { latitude: 32.06, longitude: 118.78 } });
const NETWORKS = [
  ['8.8.8.0', 24, place('US', 'Mountain View')],
  ['117.88.0.0', 16, place('CN', 'Nanjing')],
  ['2001:db8::', 32, place('GB', 'London')],
  ['2001:4860::', 32, place('US', 'Mountain View')],
  ['198.51.100.0', 24, place('FR', '<script>')],
];

describe('MaxMind DB reader', () => {
  test.each([24, 28])('finds IPv4 and IPv6 networks (%i-bit records)', (recordSize) => {
    const reader = new geo.Reader(buildDb(NETWORKS, { recordSize }));
    expect(reader.metadata).toMatchObject({ database_type: 'DBIP-City-Lite', ip_version: 6, record_size: recordSize });
    expect(reader.get('8.8.8.8')).toEqual(place('US', 'Mountain View'));
    expect(reader.get('117.88.127.125').city.names.en).toBe('Nanjing');
    expect(reader.get('2001:db8:1:2::3').city.names.en).toBe('London');
    expect(reader.get('2001:0db8:0000:0000:0000:0000:0000:0001').country.iso_code).toBe('GB');
    expect(reader.get('9.9.9.9')).toBeNull();
    expect(reader.get('2a00::1')).toBeNull();
    expect(reader.get('not an ip')).toBeNull();
  });

  test('follows pointers to shared data', () => {
    const shared = { iso_code: 'DE', names: { en: 'Germany' } };
    const reader = new geo.Reader(buildDb([['192.0.2.0', 24, { country: { pointer: 0 }, city: { names: { en: 'Berlin' } } }]], { shared }));
    expect(reader.get('192.0.2.1')).toEqual({ country: shared, city: { names: { en: 'Berlin' } } });
  });

  test('rejects files that are not MaxMind DBs', () => {
    expect(() => new geo.Reader(Buffer.from('hello'))).toThrow('Not a MaxMind DB file');
  });

  test('parses IPv6 forms', () => {
    expect(geo.ipBytes('::1').toString('hex')).toBe('00000000000000000000000000000001');
    expect(geo.ipBytes('::ffff:1.2.3.4').toString('hex')).toBe('00000000000000000000ffff01020304');
    expect(geo.ipBytes('2001:db8::').toString('hex')).toBe('20010db8000000000000000000000000');
    expect(geo.ipBytes('10.0.0.1').toString('hex')).toBe('0a000001');
  });
});

describe('cityFor', () => {
  const reader = new geo.Reader(buildDb(NETWORKS));
  test('keeps the city only when DB-IP agrees on the country', () => {
    expect(geo.cityFor(reader, '117.88.127.125', 'CN')).toBe('Nanjing');
    expect(geo.cityFor(reader, '117.88.127.125', 'JP')).toBeNull();
    expect(geo.cityFor(reader, '117.88.127.125', null)).toBeNull();
    expect(geo.cityFor(reader, '9.9.9.9', 'US')).toBeNull();
  });
  test('drops names that do not look like a place', () => {
    expect(geo.cityFor(reader, '198.51.100.7', 'FR')).toBeNull();
  });
});

// A bucket that keeps puts in memory.
function fakeS3(objects = {}) {
  const store = new Map(Object.entries(objects));
  const puts = [];
  const s3 = {
    send: async (command) => {
      const { Key, Body } = command.input;
      if (command.constructor.name === 'PutObjectCommand') {
        puts.push(Key);
        store.set(Key, Body);
        return {};
      }
      if (!store.has(Key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      const body = Buffer.from(store.get(Key));
      return { Body: { transformToString: async () => body.toString('utf8'), transformToByteArray: async () => new Uint8Array(body) } };
    },
  };
  return { s3, store, puts };
}

const lines = (body) => String(body).split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('fillCities', () => {
  const rows = [
    { dt: '2026-11-01', ip: '117.88.127.125', has_city: false, country: 'CN' },
    { dt: '2026-11-01', ip: '8.8.8.8', has_city: true, country: 'US' },
    { dt: '2026-11-01', ip: '2001:db8::5', has_city: false, country: 'FR' },
    { dt: '2026-10-31', ip: '2001:db8::5', has_city: false, country: 'GB' },
    { dt: '2026-10-31', ip: '192.0.2.1', has_city: false, country: null },
  ];

  test('saves, per day, the cities of IPs CloudFront gave none', async () => {
    const bucket = fakeS3({ [geo.DB_KEY]: buildDb(NETWORKS) });
    expect(await geo.fillCities(rows, bucket.s3, 'logs')).toEqual({ wanted: 3, found: 2 });
    expect(lines(bucket.store.get('cities/dt=2026-11-01/cities.json'))).toEqual([{ ip: '117.88.127.125', city: 'Nanjing' }]);
    expect(lines(bucket.store.get('cities/dt=2026-10-31/cities.json'))).toEqual([{ ip: '2001:db8::5', city: 'London' }]);
  });

  test('does not read the database when every IP has a city, and still replaces old files', async () => {
    const bucket = fakeS3();
    let loads = 0;
    const result = await geo.fillCities([rows[1]], bucket.s3, 'logs', { loadReader: async () => { loads++; return null; } });
    expect(result).toEqual({ wanted: 0, found: 0 });
    expect(loads).toBe(0);
    expect(bucket.store.get('cities/dt=2026-11-01/cities.json')).toBe('');
  });

  test('skips, keeping the last files, until the database has been downloaded', async () => {
    const bucket = fakeS3();
    expect(await geo.fillCities(rows, bucket.s3, 'logs')).toEqual({ skipped: 'no city database yet', wanted: 3 });
    expect(bucket.puts).toEqual([]);
  });
});

describe('monthly download', () => {
  const NOW = Date.UTC(2026, 10, 2, 3, 0, 0);
  const gz = (buffer) => zlib.gzipSync(buffer);
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => String(body.length) }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) });
  const missing = { ok: false, status: 404, headers: { get: () => null } };

  test('saves this month\'s database, then skips until the next month', async () => {
    const bucket = fakeS3();
    const urls = [];
    const fetchImpl = async (url) => { urls.push(url); return ok(gz(buildDb(NETWORKS))); };
    const saved = await geo.update({}, { s3: bucket.s3, bucket: 'logs', now: NOW, fetchImpl });
    expect(urls).toEqual(['https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz']);
    expect(saved).toMatchObject({ month: '2026-11', database_type: 'DBIP-City-Lite', build_epoch: 1793491200 });
    expect(bucket.puts).toEqual([geo.DB_KEY, geo.INFO_KEY]);
    expect(new geo.Reader(bucket.store.get(geo.DB_KEY)).get('117.88.1.1').city.names.en).toBe('Nanjing');
    expect(await geo.update({}, { s3: bucket.s3, bucket: 'logs', now: NOW + 86400000, fetchImpl })).toEqual({ skipped: 'already up to date', month: '2026-11' });
    expect(urls).toHaveLength(1);
  });

  test('uses last month\'s while this month\'s is not out', async () => {
    const bucket = fakeS3();
    const fetchImpl = async (url) => (url.includes('2026-11') ? missing : ok(gz(buildDb(NETWORKS))));
    expect(await geo.update({}, { s3: bucket.s3, bucket: 'logs', now: NOW, fetchImpl })).toMatchObject({ month: '2026-10' });
    // Next day, this month's is out.
    const later = async () => ok(gz(buildDb(NETWORKS)));
    expect(await geo.update({}, { s3: bucket.s3, bucket: 'logs', now: NOW + 86400000, fetchImpl: later })).toMatchObject({ month: '2026-11' });
  });

  test('keeps the saved copy if the download does not look right', async () => {
    const bucket = fakeS3();
    const wrong = buildDb([['8.8.8.0', 24, place('GB', 'London')]]);
    await expect(geo.update({}, { s3: bucket.s3, bucket: 'logs', now: NOW, fetchImpl: async () => ok(gz(wrong)) })).rejects.toThrow('check failed for 8.8.8.8');
    await expect(geo.update({}, { s3: bucket.s3, bucket: 'logs', now: NOW, fetchImpl: async () => ok(gz(buildDb(NETWORKS, { type: 'GeoLite2-ASN' }))) })).rejects.toThrow('Unexpected database type');
    await expect(geo.update({}, { s3: bucket.s3, bucket: 'logs', now: NOW, fetchImpl: async () => ok(gz(Buffer.from('nope'))) })).rejects.toThrow('Not a MaxMind DB file');
    await expect(geo.update({}, { s3: bucket.s3, bucket: 'logs', now: NOW, fetchImpl: async () => missing })).rejects.toThrow('No DB-IP city database found for 2026-11 or 2026-10');
    expect(bucket.puts).toEqual([]);
  });
});
