#!/usr/bin/env node
'use strict';
// One-off clean-up: logs filed before the partitioner redacted cookies hold the whole Cookie header,
// including the sites' sign-in session cookies. This rewrites every file under logs/ and archive/ so the
// cs(Cookie) column keeps only the dl_vid visitor ID. The bucket is not versioned, so the old copies are
// gone once overwritten. Safe to run more than once.
//
// Usage: node scripts/redact-cookies.js --bucket <log bucket> [--dry-run]
const zlib = require('zlib');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { redactLogText } = require('../lambda/partitioner');
const { gunzipIfNeeded, isLogFile, listKeys, readObject } = require('../lambda/dashboard/logfile');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const bucket = arg('bucket');
  const dryRun = process.argv.includes('--dry-run');
  if (!bucket) throw new Error('Usage: redact-cookies.js --bucket <log bucket> [--dry-run]');
  const s3 = new S3Client({});
  let checked = 0;
  let changed = 0;
  for (const prefix of ['logs/', 'archive/']) {
    for (const key of (await listKeys(s3, bucket, prefix)).filter(isLogFile)) {
      checked += 1;
      const raw = await readObject(s3, bucket, key);
      const text = gunzipIfNeeded(raw).toString('utf8');
      const redacted = redactLogText(text);
      if (redacted === text) continue;
      changed += 1;
      if (dryRun) continue;
      const gzipped = raw.length > 1 && raw[0] === 0x1f && raw[1] === 0x8b;
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: gzipped ? zlib.gzipSync(redacted) : redacted,
        ContentType: gzipped ? 'application/gzip' : 'text/plain',
      }));
    }
  }
  console.log(JSON.stringify({ checked, changed, dryRun }));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
