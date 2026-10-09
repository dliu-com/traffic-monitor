#!/usr/bin/env node
'use strict';
// One-off clean-up for the switch to CloudFront standard logging v2. While both log types were on,
// each request was logged twice. This removes, from the legacy files of one hour, every row whose
// edge request ID also appears in that day's v2 files. Safe to run more than once.
//
// Usage: node scripts/dedupe-overlap.js --bucket <log bucket> [--day 2026-10-09] [--hour 21] [--dry-run]
const zlib = require('zlib');
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { LEGACY_LAST_HOUR } = require('../lambda/partitioner');

const REQUEST_ID = 14; // x-edge-request-id, in both the legacy and the normalised v2 column order

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

// Returns the file without rows whose request ID is in `seen`, and how many rows were dropped.
function withoutSeen(text, seen) {
  let dropped = 0;
  const kept = text.split('\n').filter((line) => {
    if (!line || line.startsWith('#')) return true;
    if (seen.has(line.split('\t')[REQUEST_ID])) {
      dropped += 1;
      return false;
    }
    return true;
  });
  return { text: kept.join('\n'), dropped };
}

async function main() {
  const bucket = arg('bucket');
  const [day, hour] = [arg('day', LEGACY_LAST_HOUR.slice(0, 10)), arg('hour', LEGACY_LAST_HOUR.slice(11))];
  const dryRun = process.argv.includes('--dry-run');
  if (!bucket || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}$/.test(hour)) {
    throw new Error('Usage: dedupe-overlap.js --bucket <log bucket> [--day YYYY-MM-DD] [--hour HH] [--dry-run]');
  }
  const s3 = new S3Client({});
  const read = async (key) => {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return zlib.gunzipSync(Buffer.from(await object.Body.transformToByteArray())).toString('utf8');
  };
  const list = async (prefix, delimiter) => {
    const out = [];
    let token;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: delimiter, ContinuationToken: token }));
      out.push(...(delimiter ? (page.CommonPrefixes || []).map((p) => p.Prefix) : (page.Contents || []).map((o) => o.Key)));
      token = page.NextContinuationToken;
    } while (token);
    return out;
  };

  for (const sitePrefix of await list('logs/site=', '/')) {
    const keys = await list(`${sitePrefix}dt=${day}/`);
    const v2 = keys.filter((key) => key.split('/').pop().startsWith('v2-'));
    const legacy = keys.filter((key) => !key.split('/').pop().startsWith('v2-') && key.includes(`.${day}-${hour}.`));
    if (!v2.length || !legacy.length) continue;
    const seen = new Set();
    for (const key of v2) {
      for (const line of (await read(key)).split('\n')) {
        if (line && !line.startsWith('#')) seen.add(line.split('\t')[REQUEST_ID]);
      }
    }
    for (const key of legacy) {
      const { text, dropped } = withoutSeen(await read(key), seen);
      if (!dropped) continue;
      console.log(`${dryRun ? 'would drop' : 'dropped'} ${dropped} duplicate row(s) from ${key}`);
      if (!dryRun) {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: zlib.gzipSync(text), ContentType: 'application/gzip' }));
      }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { withoutSeen, REQUEST_ID };
