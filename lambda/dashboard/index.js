'use strict';

const auth = require('./auth');
const { loadConfig, NotConfigured } = require('./config');
const { runQuery } = require('./athena');
const { loadHosting } = require('./hosting');
const { STATUS_KEY, readStatus } = require('./bots');
const { BadRequest, PAGE_MAX, ipQueries, listQuery, overviewQueries, pageQueries, parseFilters, settings } = require('./queries');

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(statusCode, body, cookies, headers = {}) {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers },
    ...(cookies ? { cookies } : {}),
    body: JSON.stringify(body),
  };
}

function redirect(location, cookies) {
  return { statusCode: 302, headers: { ...SECURITY_HEADERS, location }, ...(cookies ? { cookies } : {}), body: '' };
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function errorPage(statusCode, message, cookies) {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' },
    ...(cookies ? { cookies } : {}),
    body: `<!doctype html><meta charset="utf-8"><title>Traffic</title><link rel="stylesheet" href="/style.css">
<body><main class="error-page"><h1>Sign-in problem</h1><p>${escapeHtml(message)}</p><p><a href="/auth/login">Try again</a></p></main></body>`,
  };
}

// A run longer than the classifier's 15-minute timeout has died, so another may start.
const RUN_STALE_MS = 16 * 60 * 1000;

let s3Client;
let lambdaClient;
const s3 = () => {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({});
  }
  return s3Client;
};
const lambdaApi = () => {
  if (!lambdaClient) {
    const { LambdaClient } = require('@aws-sdk/client-lambda');
    lambdaClient = new LambdaClient({});
  }
  return lambdaClient;
};

const isRunning = (status, now) => Boolean(status && status.state === 'running' && now - Date.parse(status.started) < RUN_STALE_MS);

// "Check bots now": starts the bot classifier in the background (last week plus today) unless a run is going.
async function startBotRun(deps, now) {
  const client = deps.s3 || s3();
  const bucket = process.env.BOTS_BUCKET;
  if (isRunning(await readStatus(client, bucket), now)) return json(409, { error: 'A bot check is already running.' });
  const started = new Date(now).toISOString();
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const write = (status) => client.send(new PutObjectCommand({
    Bucket: bucket, Key: STATUS_KEY, ContentType: 'application/json', Body: JSON.stringify(status),
  }));
  await write({ state: 'running', trigger: 'dashboard', started });
  const { InvokeCommand } = require('@aws-sdk/client-lambda');
  try {
    await (deps.lambda || lambdaApi()).send(new InvokeCommand({
      FunctionName: process.env.BOTS_FUNCTION,
      InvocationType: 'Event',
      Payload: JSON.stringify({ trigger: 'dashboard', includeToday: true }),
    }));
  } catch (error) {
    await write({ state: 'failed', trigger: 'dashboard', started, finished: started, error: 'The bot check could not be started.' }).catch(() => {});
    throw error;
  }
  return json(202, { status: { state: 'running', trigger: 'dashboard', started } });
}

function createHandler(deps = {}) {
  const getConfig = deps.loadConfig || loadConfig;
  const query = deps.runQuery || runQuery;
  const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
  const clock = deps.now || Date.now;
  const hosting = deps.loadHosting || loadHosting;

  return async function handler(event) {
    const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'GET';
    const path = event.rawPath || '/';
    const params = event.queryStringParameters || {};
    const siteUrl = process.env.SITE_URL;
    const botRun = path === '/api/bots/run';
    if (botRun ? method !== 'POST' : method !== 'GET') return json(405, { error: 'Method not allowed' });

    try {
      const config = await getConfig();

      if (path === '/auth/login') {
        const login = auth.startLogin(config, siteUrl, clock());
        return redirect(login.location, login.cookies);
      }
      if (path === '/auth/callback') {
        const result = await auth.finishLogin(event, config, siteUrl, { fetchImpl, now: clock() });
        return result.location ? redirect(result.location, result.cookies) : errorPage(result.status, result.error, result.cookies);
      }
      if (path === '/auth/logout') return redirect('/', auth.logoutCookies());

      if (!path.startsWith('/api/')) return json(404, { error: 'Not found' });
      const session = auth.getSession(event, config, clock());
      if (!session) return json(401, { error: 'Not signed in' });

      if (botRun) {
        // Cross-site requests carry no session (SameSite=Lax); the Origin check is a second guard.
        const origin = (event.headers && event.headers.origin) || '';
        if (origin !== siteUrl) return json(403, { error: 'Forbidden' });
        return await startBotRun(deps, clock());
      }
      if (path === '/api/bots') {
        const status = await readStatus(deps.s3 || s3(), process.env.BOTS_BUCKET);
        return json(200, { status: status && status.state === 'running' && !isRunning(status, clock()) ? { ...status, state: 'failed', error: 'The bot check stopped without finishing.' } : status });
      }
      if (path === '/api/me') return json(200, { user: session.user, name: session.name, sites: settings().siteHosts });
      // Network names for the Browser column; the browser keeps them for an hour (they change weekly).
      if (path === '/api/networks') return json(200, { networks: await hosting() }, undefined, { 'cache-control': 'private, max-age=3600' });
      if (path === '/api/overview' || path === '/api/ip' || path === '/api/page') {
        const filters = parseFilters(path === '/api/ip' ? { ...params, site: 'all' } : params, clock());
        const queries = path === '/api/ip' ? ipQueries(filters, params.ip)
          : path === '/api/page' ? pageQueries(filters, params.path) : overviewQueries(filters);
        // part=<name> runs one query, so each dashboard widget can load and appear on its own.
        if (params.part !== undefined) {
          if (!Object.hasOwn(queries, params.part)) throw new BadRequest('Unknown part');
          return json(200, { filters, rows: await query(queries[params.part]) });
        }
        const names = Object.keys(queries);
        const results = await Promise.all(names.map((name) => query(queries[name])));
        return json(200, { filters, ...Object.fromEntries(names.map((name, i) => [name, results[i]])) });
      }
      if (path === '/api/list') {
        const filters = parseFilters(params, clock());
        const { sql, limit, offset } = listQuery(filters, params);
        const rows = await query(sql, { maxRows: PAGE_MAX });
        const total = rows.length ? Number(rows[0].total) : 0;
        return json(200, { filters, offset, limit, total, rows: rows.map(({ total: _, ...row }) => row) });
      }
      return json(404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof BadRequest) return json(400, { error: error.message });
      if (error instanceof NotConfigured) {
        console.error(JSON.stringify({ message: 'Dashboard not configured', path, error: error.message }));
        const text = 'Sign-in is not configured yet. Run "make set-secrets".';
        return path.startsWith('/auth/') ? errorPage(503, text) : json(503, { error: text });
      }
      console.error(JSON.stringify({ message: 'Request failed', path, error: error.message, stack: error.stack }));
      if (path.startsWith('/auth/')) return errorPage(500, 'Something went wrong while signing in.');
      return json(500, { error: 'Internal error' });
    }
  };
}

module.exports = { createHandler, handler: createHandler() };
