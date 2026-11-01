'use strict';

// Cities for IPs CloudFront gave no city, from DB-IP's free "IP to City Lite" database (CC BY 4.0,
// https://db-ip.com; credited on the About page). A monthly job (handler `geo.update`) downloads the month's
// database to s3://<log bucket>/geodb/dbip-city-lite.mmdb. The bot check (bots.js) looks up the IPs that had
// no CloudFront city on a day, keeps DB-IP's city only when DB-IP places the IP in the same country as
// CloudFront, and saves them as JSON lines under cities/dt=<day>/cities.json (Glue table ip_cities). The
// dashboard shows those as "<city> (DB-IP)". Lookups are local, so there is no API, key or limit.

const net = require('net');
const zlib = require('zlib');

const DB_KEY = 'geodb/dbip-city-lite.mmdb';
const INFO_KEY = 'geodb/dbip-city-lite.json';
const CITIES_PREFIX = 'cities/';
const MAX_DOWNLOAD = 150 * 1024 * 1024;
const MAX_DB = 400 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 8 * 60 * 1000;
const downloadUrl = (month) => `https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz`;
// The same rule as the dashboard's (queries.js CITY): a place name of letters, digits, marks, spaces and . ' ’ ( ) , -
const CITY = /^[\p{L}\p{M}\p{N} .'’(),-]{1,60}$/u;
const COUNTRY = /^[A-Z]{2}$/;

// ---------- MaxMind DB (.mmdb) reader: https://maxmind.github.io/MaxMind-DB/ ----------
const METADATA_MARKER = Buffer.from('abcdef4d61784d696e642e636f6d', 'hex');

class Reader {
  constructor(buffer) {
    const marker = buffer.lastIndexOf(METADATA_MARKER);
    if (marker < 0) throw new Error('Not a MaxMind DB file');
    this.buffer = buffer;
    const metaStart = marker + METADATA_MARKER.length;
    const metadata = this.decode(metaStart, metaStart)[0];
    const { node_count: nodeCount, record_size: recordSize, ip_version: ipVersion } = metadata || {};
    if (!Number.isInteger(nodeCount) || ![24, 28, 32].includes(recordSize) || ![4, 6].includes(ipVersion)) throw new Error('Unsupported MaxMind DB metadata');
    this.metadata = metadata;
    this.nodeCount = nodeCount;
    this.recordSize = recordSize;
    this.treeSize = (nodeCount * recordSize * 2) / 8;
    this.dataStart = this.treeSize + 16;
    if (this.dataStart > marker) throw new Error('Corrupt MaxMind DB file');
    // IPv4 addresses live under ::/96 in an IPv6 tree.
    let node = 0;
    if (ipVersion === 6) for (let i = 0; i < 96 && node < nodeCount; i++) node = this.record(node, 0);
    this.ipv4Start = node;
  }

  record(node, bit) {
    const b = this.buffer;
    if (this.recordSize === 24) return b.readUIntBE(node * 6 + bit * 3, 3);
    if (this.recordSize === 28) {
      const o = node * 7;
      return bit === 0 ? ((b[o + 3] & 0xf0) << 20) + b.readUIntBE(o, 3) : ((b[o + 3] & 0x0f) << 24) + b.readUIntBE(o + 4, 3);
    }
    return b.readUInt32BE(node * 8 + bit * 4);
  }

  // Returns [value, offset after it]. Pointers are relative to `base` (the data section, or the metadata).
  decode(offset, base) {
    const b = this.buffer;
    const control = b[offset++];
    let type = control >> 5;
    if (type === 1) {
      const ss = (control >> 3) & 3;
      const v = control & 7;
      let pointer;
      if (ss === 0) { pointer = (v << 8) + b[offset]; offset += 1; }
      else if (ss === 1) { pointer = (v << 16) + b.readUInt16BE(offset) + 2048; offset += 2; }
      else if (ss === 2) { pointer = v * 2 ** 24 + b.readUIntBE(offset, 3) + 526336; offset += 3; }
      else { pointer = b.readUInt32BE(offset); offset += 4; }
      return [this.decode(base + pointer, base)[0], offset];
    }
    if (type === 0) type = 7 + b[offset++];
    let size = control & 0x1f;
    if (size === 29) size = 29 + b[offset++];
    else if (size === 30) { size = 285 + b.readUInt16BE(offset); offset += 2; }
    else if (size === 31) { size = 65821 + b.readUIntBE(offset, 3); offset += 3; }
    switch (type) {
      case 2: return [b.toString('utf8', offset, offset + size), offset + size];
      case 3: return [b.readDoubleBE(offset), offset + 8];
      case 4: return [b.subarray(offset, offset + size), offset + size];
      case 5: case 6: case 9: case 10: {
        let value = 0n;
        for (let i = 0; i < size; i++) value = (value << 8n) | BigInt(b[offset + i]);
        return [value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value, offset + size];
      }
      case 7: {
        const map = {};
        for (let i = 0; i < size; i++) {
          const [key, afterKey] = this.decode(offset, base);
          const [value, afterValue] = this.decode(afterKey, base);
          map[key] = value;
          offset = afterValue;
        }
        return [map, offset];
      }
      case 8: return [size === 0 ? 0 : b.readIntBE(offset, size) << (32 - size * 8) >> (32 - size * 8), offset + size];
      case 11: {
        const list = [];
        for (let i = 0; i < size; i++) {
          const [value, after] = this.decode(offset, base);
          list.push(value);
          offset = after;
        }
        return [list, offset];
      }
      case 14: return [size !== 0, offset];
      case 15: return [b.readFloatBE(offset), offset + 4];
      default: throw new Error(`Unsupported MaxMind DB data type ${type}`);
    }
  }

  // The record for an IP address, or null.
  get(ip) {
    const bytes = ipBytes(ip);
    if (!bytes) return null;
    if (bytes.length === 16 && this.metadata.ip_version === 4) return null;
    let node = bytes.length === 4 ? this.ipv4Start : 0;
    for (let i = 0; i < bytes.length * 8 && node < this.nodeCount; i++) node = this.record(node, (bytes[i >> 3] >> (7 - (i & 7))) & 1);
    if (node <= this.nodeCount) return null;
    return this.decode(this.treeSize + (node - this.nodeCount), this.dataStart)[0];
  }
}

function ipBytes(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return Buffer.from(ip.split('.').map(Number));
  if (kind !== 6) return null;
  let text = ip.split('%')[0].toLowerCase();
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':') + 1;
    const [a, b, c, d] = text.slice(cut).split('.').map(Number);
    text = `${text.slice(0, cut)}${((a << 8) + b).toString(16)}:${((c << 8) + d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const bytes = Buffer.alloc(16);
  groups.forEach((group, i) => bytes.writeUInt16BE(parseInt(group, 16), i * 2));
  return bytes;
}

// DB-IP's English city name for an IP, if DB-IP places it in `country` (CloudFront's country code).
function cityFor(reader, ip, country) {
  if (!COUNTRY.test(country || '')) return null;
  const found = reader.get(ip);
  if (!found || !found.country || found.country.iso_code !== country) return null;
  const name = found.city && found.city.names && found.city.names.en;
  return typeof name === 'string' && CITY.test(name) ? name : null;
}

// ---------- S3 ----------
let s3Client;
const s3 = () => {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({});
  }
  return s3Client;
};

async function readInfo(client, bucket) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: INFO_KEY }));
    const info = JSON.parse(await result.Body.transformToString());
    return info && typeof info === 'object' ? info : null;
  } catch (error) {
    if (error.name === 'NoSuchKey' || error instanceof SyntaxError) return null;
    throw error;
  }
}

// The saved database, or null if there is none yet.
async function loadReader(client, bucket) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: DB_KEY }));
    return new Reader(Buffer.from(await result.Body.transformToByteArray()));
  } catch (error) {
    if (error.name === 'NoSuchKey') return null;
    throw error;
  }
}

async function put(client, bucket, key, body, contentType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

// Monthly job: saves this month's database (or last month's, if this month's is not out yet) unless the saved
// copy is already that new. Throws, keeping the saved copy, if the download does not look right.
async function update(event = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
  const client = deps.s3 || s3();
  const bucket = deps.bucket || process.env.GEO_BUCKET;
  if (!bucket) throw new Error('GEO_BUCKET is not set');
  const now = deps.now ?? Date.now();
  const thisMonth = monthOf(now);
  const lastMonth = monthOf(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 0));
  const info = await readInfo(client, bucket);
  for (const month of [thisMonth, lastMonth]) {
    if (info && info.month >= month && !(event && event.force)) {
      const skipped = { skipped: 'already up to date', month: info.month };
      console.log(JSON.stringify({ message: 'City database unchanged', ...skipped }));
      return skipped;
    }
    const response = await fetchImpl(downloadUrl(month), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`DB-IP returned HTTP ${response.status}`);
    const length = Number(response.headers && response.headers.get ? response.headers.get('content-length') : NaN);
    if (length > MAX_DOWNLOAD) throw new Error('City database download too large');
    const packed = Buffer.from(await response.arrayBuffer());
    if (packed.length > MAX_DOWNLOAD) throw new Error('City database download too large');
    const db = zlib.gunzipSync(packed, { maxOutputLength: MAX_DB });
    const reader = new Reader(db);
    const type = String(reader.metadata.database_type || '');
    if (!/city/i.test(type)) throw new Error(`Unexpected database type ${type}`);
    // DB-IP places Google's IPv6 DNS in Canada, so IPv6 only needs some country.
    for (const [ip, country] of [['8.8.8.8', 'US'], ['2001:4860:4860::8888', null]]) {
      const found = reader.get(ip);
      const code = found && found.country && found.country.iso_code;
      if (!/^[A-Z]{2}$/.test(code || '') || (country && code !== country)) throw new Error(`City database check failed for ${ip}`);
    }
    await put(client, bucket, DB_KEY, db, 'application/octet-stream');
    const saved = { month, database_type: type, build_epoch: Number(reader.metadata.build_epoch) || null, bytes: db.length, updated: new Date(now).toISOString() };
    await put(client, bucket, INFO_KEY, JSON.stringify(saved), 'application/json');
    console.log(JSON.stringify({ message: 'City database updated', ...saved }));
    return saved;
  }
  throw new Error(`No DB-IP city database found for ${thisMonth} or ${lastMonth}`);
}

// For the bot check: per day, the cities of IPs CloudFront gave no city (rows from bot-state.featureRows),
// saved to cities/dt=<day>/cities.json, replacing the last run's. The database is read only when needed.
async function fillCities(rows, client, bucket, deps = {}) {
  const byDay = new Map();
  for (const row of rows) if (!byDay.has(row.dt)) byDay.set(row.dt, []);
  const wanted = rows.filter((row) => !row.has_city && COUNTRY.test(row.country || ''));
  let reader = null;
  if (wanted.length) {
    reader = await (deps.loadReader || loadReader)(client, bucket);
    if (!reader) return { skipped: 'no city database yet', wanted: wanted.length };
  }
  let found = 0;
  for (const row of wanted) {
    const city = cityFor(reader, row.ip, row.country);
    if (city) {
      byDay.get(row.dt).push({ ip: row.ip, city });
      found++;
    }
  }
  for (const [day, lines] of byDay) {
    await put(client, bucket, `${CITIES_PREFIX}dt=${day}/cities.json`, lines.map((line) => JSON.stringify(line)).join('\n') + (lines.length ? '\n' : ''), 'application/x-ndjson');
  }
  return { wanted: wanted.length, found };
}

module.exports = { CITIES_PREFIX, DB_KEY, INFO_KEY, Reader, cityFor, downloadUrl, fillCities, ipBytes, loadReader, update };
