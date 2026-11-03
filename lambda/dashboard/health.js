'use strict';

// GET /health for status.dliu.com (see /docs/health). No authentication: CloudFront forwards no cookies, headers or
// query string, and nothing here reads them. Read only: one cheap read per dependency (an object's metadata or a
// small fixed object, the SSM read sign-in already does, one CloudWatch metric read), never an S3 LIST, Athena query
// or third-party call. CloudFront keeps the answer for 60 seconds, so this runs at most about once a minute.
// The output is a short generic reason; no names, counts or errors are returned.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const CHECK_TIMEOUT_MS = 2000;
const RANK = { pass: 0, warn: 1, fail: 2 };

// Keys, names and order match config/health.json (a test keeps them in sync).
const FUNCTIONS = [
  { key: 'public-stats', name: 'Public statistics' },
  { key: 'signin', name: 'Microsoft sign-in' },
  { key: 'logging', name: 'Request logging' },
  { key: 'bot-check', name: 'Bot check' },
];

const worst = (...statuses) => statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'pass');

// pass up to `warnAfter`, warn up to `failAfter`, then fail (or warn when `failAfter` is null).
function byAge(time, now, warnAfter, failAfter) {
  const age = now - new Date(time).getTime();
  if (!Number.isFinite(age)) return { status: 'fail', output: 'read failed' };
  if (age <= warnAfter) return { status: 'pass' };
  if (failAfter == null || age <= failAfter) return { status: 'warn', output: 'stale' };
  return { status: 'fail', output: 'stale' };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'fail', output: 'timeout' }), ms); }),
  ]);
}

async function lastModified(s3, bucket, key) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  return (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).LastModified;
}

const CHECKS = {
  // The sign-in settings (SSM, cached 5 minutes by the config loader).
  signin: async ({ loadConfig }) => {
    await loadConfig();
    return { status: 'pass' };
  },
  // The log partitioner runs whenever CloudFront delivers a log file, several times an hour for the 10 sites
  // (status.dliu.com's own probes alone guarantee that). None in 3 hours means logging has stopped.
  logging: async ({ cloudwatch, now }) => {
    const { GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');
    const result = await cloudwatch.send(new GetMetricStatisticsCommand({
      Namespace: 'AWS/Lambda',
      MetricName: 'Invocations',
      Dimensions: [{ Name: 'FunctionName', Value: process.env.PARTITIONER_FUNCTION }],
      StartTime: new Date(now - 3 * HOUR),
      EndTime: new Date(now),
      Period: 3 * HOUR,
      Statistics: ['Sum'],
    }));
    const runs = (result.Datapoints || []).reduce((sum, point) => sum + (point.Sum || 0), 0);
    return runs > 0 ? { status: 'pass' } : { status: 'fail', output: 'no recent logs' };
  },
  // The bot check runs every 6 hours and saves its last run; the hosting list it uses is refreshed weekly.
  'bot-check': async ({ s3, now }) => {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const [statusObject, hostingTime] = await Promise.all([
      s3.send(new GetObjectCommand({ Bucket: process.env.BOTS_BUCKET, Key: 'bots/status.json' })),
      lastModified(s3, process.env.HOSTING_BUCKET, 'hosting/asns.json').catch(() => null),
    ]);
    const run = JSON.parse(await statusObject.Body.transformToString());
    const last = byAge(run.finished || run.started, now, 7 * HOUR, 25 * HOUR);
    const failed = run.state === 'failed' ? { status: 'warn', output: 'last run failed' } : { status: 'pass' };
    const hosting = hostingTime ? byAge(hostingTime, now, 8 * DAY, null) : { status: 'warn', output: 'read failed' };
    return [last, failed, hosting].reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
  },
  // Guests' statistics are rewritten daily at 02:00 UTC.
  'public-stats': async ({ s3, now }) => byAge(await lastModified(s3, process.env.SITE_BUCKET, 'stats/7d.json'), now, 26 * HOUR, 50 * HOUR),
};

async function runHealth(deps, now) {
  const functions = await Promise.all(FUNCTIONS.map(async ({ key, name }) => {
    const result = await withTimeout(Promise.resolve().then(() => CHECKS[key]({ ...deps, now })).catch(() => ({ status: 'fail', output: 'read failed' })), deps.timeoutMs || CHECK_TIMEOUT_MS);
    return { key, name, status: result.status, ...(result.output ? { output: result.output } : {}) };
  }));
  return { status: worst(...functions.map((f) => f.status)), time: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), functions };
}

function healthResponse(body) {
  return {
    statusCode: body.status === 'fail' ? 503 : 200,
    headers: {
      'content-type': 'application/health+json',
      'cache-control': 'public, max-age=60',
      'x-content-type-options': 'nosniff',
    },
    body: JSON.stringify(body),
  };
}

module.exports = { FUNCTIONS, CHECKS, runHealth, healthResponse, byAge };
