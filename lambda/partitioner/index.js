'use strict';

// Moves CloudFront standard log files from raw/<site>/<dist>.YYYY-MM-DD-HH.<id>.gz
// to logs/site=<site>/dt=YYYY-MM-DD/<file> so Athena can prune by site and day.
const RAW_KEY = /^raw\/([a-z0-9-]+)\/([^/]+\.(\d{4}-\d{2}-\d{2})-\d{2}\.[^/]+\.gz)$/;

function targetKey(rawKey) {
  const match = RAW_KEY.exec(rawKey);
  if (!match) return null;
  const [, site, file, day] = match;
  return `logs/site=${site}/dt=${day}/${file}`;
}

function decodeKey(key) {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}

let s3Client;
function client() {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({});
  }
  return s3Client;
}

async function processEvent(event, s3) {
  const { CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  for (const record of event.Records || []) {
    const bucket = record.s3.bucket.name;
    const key = decodeKey(record.s3.object.key);
    const target = targetKey(key);
    if (!target) {
      console.warn(JSON.stringify({ message: 'Skipping unexpected key', key }));
      continue;
    }
    await s3.send(new CopyObjectCommand({
      Bucket: bucket,
      Key: target,
      CopySource: `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`,
    }));
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}

// Keep the Lambda entry point at one argument: the Node.js runtime treats 3-argument
// handlers as callback-style and passes the callback as the third argument.
async function handler(event) {
  return processEvent(event, client());
}

module.exports = { handler, processEvent, targetKey, decodeKey };
