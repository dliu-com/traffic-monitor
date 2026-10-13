'use strict';

// What the bot check knows about each IP on each day, kept up to date without reading any log record twice.
// For every day it covers, bot-state/dt=<day>.json holds the log files already read and, per IP, the counts
// the rules need. Each run lists the day's log files (logs/site=<site>/dt=<day>/), reads only the ones not
// read before, adds them to the counts and saves the state; the verdicts are then worked out again from the
// counts. A run that fails before saving reads those files again next time, so nothing is missed.
// bot-state/reputation.json caches the latest AbuseIPDB result per IP (REPUTATION_DAYS), so a run needs no
// Athena query; the first run builds it from the ip_reputation table.

const { isAgent, isLogFile, listKeys, parseLog, readObject, gunzipIfNeeded, urlDecode, COLUMNS } = require('./logfile');

const STATE_PREFIX = 'bot-state/';
const stateKey = (day) => `${STATE_PREFIX}dt=${day}.json`;
const REPUTATION_CACHE_KEY = `${STATE_PREFIX}reputation.json`;
const READERS = 16;

const col = (name) => COLUMNS.indexOf(name);
const DATE = col('date');
const TIME = col('time');
const IP = col('c-ip');
const PATH = col('cs-uri-stem');
const UA = col('cs(User-Agent)');
const COOKIE = col('cs(Cookie)');
const ASN = col('asn');
const VISITOR_COOKIE = /dl_vid=[a-z0-9]{8,40}/;
const ASN_VALUE = /^[0-9]{1,10}$/;

// Per IP: [requests, browser requests, latest ASN, time of that ASN, asked for a scanner path, loaded a page].
const REQUESTS = 0;
const BROWSER = 1;
const LAST_ASN = 2;
const ASN_TIME = 3;
const PROBED = 4;
const LOADS_PAGE = 5;

// Adds one log file's rows to a day's counts. The same tests as the dashboard and the old Athena query.
function addRows(ips, rows, probe, pageFile) {
  for (const row of rows) {
    const ip = row[IP];
    const entry = ips[ip] || (ips[ip] = [0, 0, null, null, 0, 0]);
    entry[REQUESTS]++;
    if (!isAgent(row[UA])) entry[BROWSER]++;
    const asn = row[ASN];
    if (ASN_VALUE.test(asn)) {
      const time = `${row[DATE]}T${row[TIME]}Z`;
      if (entry[ASN_TIME] === null || time >= entry[ASN_TIME]) {
        entry[LAST_ASN] = asn;
        entry[ASN_TIME] = time;
      }
    }
    const path = urlDecode(row[PATH]).toLowerCase();
    if (!entry[PROBED] && probe.test(path)) entry[PROBED] = 1;
    if (!entry[LOADS_PAGE] && (pageFile.test(path) || VISITOR_COOKIE.test(urlDecode(row[COOKIE])))) entry[LOADS_PAGE] = 1;
  }
}

async function readJson(client, bucket, key) {
  try {
    return JSON.parse((await readObject(client, bucket, key)).toString('utf8'));
  } catch (error) {
    if (error.name === 'NoSuchKey') return null;
    throw error;
  }
}

async function putJson(client, bucket, key, value) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(value), ContentType: 'application/json' }));
}

async function inParallel(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Brings each day's state up to date with its new log files. Returns the states (not yet saved) and the
// number of files read.
async function refresh(client, bucket, days, sites, { probe, pageFile }) {
  // One list per site covers all the days: from the oldest day's folder to the end (no later days exist).
  const oldest = [...days].sort()[0];
  const byDay = new Map(days.map((day) => [day, []]));
  for (const site of sites) {
    const prefix = `logs/site=${site}/dt=`;
    for (const key of await listKeys(client, bucket, prefix, `${prefix}${oldest}`)) {
      const day = key.slice(prefix.length, prefix.length + 10);
      if (byDay.has(day) && key[prefix.length + 10] === '/' && isLogFile(key)) byDay.get(day).push(key);
    }
  }
  const states = {};
  let read = 0;
  for (const day of days) {
    const saved = await readJson(client, bucket, stateKey(day));
    const state = saved && saved.version === 1 && saved.day === day ? saved : { version: 1, day, files: [], ips: {} };
    const known = new Set(state.files);
    const fresh = byDay.get(day).filter((key) => !known.has(key));
    const parsed = new Map();
    await inParallel(fresh, READERS, async (key) => {
      parsed.set(key, parseLog(gunzipIfNeeded(await readObject(client, bucket, key)).toString('utf8')));
    });
    for (const key of fresh.sort()) {
      addRows(state.ips, parsed.get(key), probe, pageFile);
      state.files.push(key);
    }
    read += fresh.length;
    states[day] = state;
  }
  return { states, read };
}

async function save(client, bucket, states) {
  for (const state of Object.values(states)) await putJson(client, bucket, stateKey(state.day), state);
}

// The rows the rules work on, one per day and IP, like the old Athena query's.
function featureRows(states) {
  const rows = [];
  for (const state of Object.values(states)) {
    for (const [ip, e] of Object.entries(state.ips)) {
      rows.push({
        dt: state.day, ip, requests: e[REQUESTS], browser_requests: e[BROWSER], asn: e[LAST_ASN],
        probe: e[PROBED] === 1, loads_page: e[LOADS_PAGE] === 1,
      });
    }
  }
  return rows;
}

// The latest AbuseIPDB result per IP, checked since `since` (an ISO time). null if there is no cache yet.
async function readReputation(client, bucket, since) {
  const cache = await readJson(client, bucket, REPUTATION_CACHE_KEY);
  if (!cache || cache.version !== 1 || !cache.ips) return null;
  const reputation = new Map();
  for (const [ip, r] of Object.entries(cache.ips)) if (r && r.checked >= since) reputation.set(ip, { ip, ...r });
  return reputation;
}

async function saveReputation(client, bucket, reputation, since) {
  const ips = {};
  for (const [ip, r] of reputation) {
    if (r.checked >= since) ips[ip] = { score: Number.isFinite(Number(r.score)) ? Number(r.score) : null, usage_type: r.usage_type ?? null, is_tor: r.is_tor === true || r.is_tor === 'true', checked: r.checked };
  }
  await putJson(client, bucket, REPUTATION_CACHE_KEY, { version: 1, ips });
}

module.exports = { REPUTATION_CACHE_KEY, STATE_PREFIX, addRows, featureRows, readReputation, refresh, save, saveReputation, stateKey };
