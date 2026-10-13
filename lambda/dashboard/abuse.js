'use strict';

// The /abuse-check page (signed in only): how the daily AbuseIPDB lookups (bots.js) used the free
// allowance, from the run history files (abuseipdb/runs/), and what the results were (ip_reputation).

const { DAILY_LIMIT, DEFAULT_DAYS, RUNS_PREFIX, ABUSE_SCORE, DATA_CENTER } = require('./bots');
const { isoDay, settings } = require('./queries');

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 30;
const MAX_ABUSIVE = 500;
const RUN_FILE = /^abuseipdb\/runs\/dt=\d{4}-\d{2}-\d{2}\/[0-9TZ]+\.json$/;

async function readRuns(client, bucket, now) {
  const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const keys = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: RUNS_PREFIX, StartAfter: `${RUNS_PREFIX}dt=${isoDay(now - HISTORY_DAYS * DAY_MS)}`, ContinuationToken: token,
    }));
    for (const item of page.Contents || []) if (RUN_FILE.test(item.Key)) keys.push(item.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token && keys.length < 1000);
  const runs = await Promise.all(keys.map(async (key) => {
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return JSON.parse(await object.Body.transformToString());
    } catch {
      return null;
    }
  }));
  return runs.filter((run) => run && run.version === 1 && run.started && run.days).sort((a, b) => a.started.localeCompare(b.started));
}

const n = (value) => Number(value) || 0;

// Lookups per day, IPs per log day and what is waiting, from the run history (oldest run first).
function summarize(runs, now) {
  const today = isoDay(now);
  const byRunDay = new Map();
  for (const run of runs) {
    const day = run.started.slice(0, 10);
    const row = byRunDay.get(day) || { day, runs: 0, looked_up: 0, limit_hit: false, failures: 0, remaining: null };
    row.runs++;
    row.looked_up += n(run.looked_up);
    row.limit_hit = row.limit_hit || run.limit_hit === true;
    row.failures += n(run.failures);
    if (run.remaining != null) row.remaining = n(run.remaining);
    byRunDay.set(day, row);
  }

  // Per log day: the counts of the latest run that covered it, lookups summed over every run, and the IPs
  // left unchecked by the last scheduled run that covered it (those are dropped and treated as people).
  const logDays = new Map();
  for (const run of runs) {
    for (const [day, counts] of Object.entries(run.days)) {
      const row = logDays.get(day) || { day, seen: 0, people: 0, skipped: 0, looked_up: 0, abusive: 0, left: 0, dropped: null };
      Object.assign(row, { seen: n(counts.seen), people: n(counts.people), skipped: n(counts.skipped), left: n(counts.left) });
      row.looked_up += n(counts.looked_up);
      row.abusive += n(counts.abusive);
      if (run.trigger === 'schedule' && run.from === day) row.dropped = n(counts.left);
      logDays.set(day, row);
    }
  }

  // The next scheduled run covers the last DEFAULT_DAYS full days, so these IPs are still in the queue.
  const last = runs[runs.length - 1] || null;
  const oldestKept = isoDay(now - (DEFAULT_DAYS - 1) * DAY_MS);
  const waiting = last ? Object.entries(last.days).filter(([day]) => day >= oldestKept).reduce((sum, [, c]) => sum + n(c.left), 0) : 0;
  const todayRow = byRunDay.get(today);
  const next = new Date(now);
  next.setUTCHours(0, 30, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return {
    limit: DAILY_LIMIT,
    today: {
      looked_up: todayRow ? todayRow.looked_up : 0,
      remaining: todayRow ? todayRow.remaining : null,
      limit_hit: todayRow ? todayRow.limit_hit : false,
    },
    waiting,
    next_run: next.toISOString(),
    last_run: last && { started: last.started, finished: last.finished, trigger: last.trigger, from: last.from, to: last.to, looked_up: n(last.looked_up), stopped: last.stopped || null },
    runs: [...byRunDay.values()].sort((a, b) => b.day.localeCompare(a.day)),
    days: [...logDays.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, HISTORY_DAYS + DEFAULT_DAYS),
  };
}

// The latest AbuseIPDB result per IP looked up in the last 30 days.
function reputationQueries(now, env = process.env) {
  const { database, reputationTable } = settings(env);
  const latest = `WITH latest AS (
  SELECT ip, max_by(score, checked) AS score, max_by(reports, checked) AS reports, max_by(usage_type, checked) AS usage_type,
    max_by(isp, checked) AS isp, max_by(is_tor, checked) AS is_tor, max(checked) AS checked
  FROM "${database}"."${reputationTable}"
  WHERE dt BETWEEN '${isoDay(now - (HISTORY_DAYS - 1) * DAY_MS)}' AND '${isoDay(now)}'
  GROUP BY ip
)`;
  const abusive = `(score >= ${ABUSE_SCORE} OR is_tor OR usage_type = '${DATA_CENTER}')`;
  return {
    summary: `${latest}
SELECT count(*) AS ips, count_if(${abusive}) AS abusive, count_if(score >= ${ABUSE_SCORE}) AS high_score,
  count_if(is_tor) AS tor, count_if(usage_type = '${DATA_CENTER}') AS data_center
FROM latest`,
    scores: `${latest}
SELECT CASE WHEN score IS NULL THEN 'none' WHEN score = 0 THEN '0' WHEN score < 25 THEN '1-24' WHEN score < 50 THEN '25-49'
  WHEN score < 75 THEN '50-74' ELSE '75-100' END AS bucket, count(*) AS ips
FROM latest GROUP BY 1 ORDER BY 1`,
    usage: `${latest}
SELECT coalesce(nullif(usage_type, ''), 'Unknown') AS usage_type, count(*) AS ips, count_if(score >= ${ABUSE_SCORE}) AS high_score
FROM latest GROUP BY 1 ORDER BY ips DESC, usage_type LIMIT 30`,
    abusive: `${latest}
SELECT ip, score, reports, usage_type, isp, is_tor, checked
FROM latest WHERE ${abusive}
ORDER BY score DESC, reports DESC, checked DESC, ip LIMIT ${MAX_ABUSIVE}`,
  };
}

module.exports = { HISTORY_DAYS, MAX_ABUSIVE, readRuns, reputationQueries, summarize };
