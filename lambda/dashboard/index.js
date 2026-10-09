'use strict';

const auth = require('./auth');
const { loadConfig, NotConfigured } = require('./config');
const { runQuery } = require('./athena');
const { BadRequest, ipQueries, overviewQueries, parseFilters, requestsQuery, settings } = require('./queries');

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(statusCode, body, cookies) {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' },
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

function createHandler(deps = {}) {
  const getConfig = deps.loadConfig || loadConfig;
  const query = deps.runQuery || runQuery;
  const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
  const clock = deps.now || Date.now;

  return async function handler(event) {
    const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'GET';
    const path = event.rawPath || '/';
    const params = event.queryStringParameters || {};
    const siteUrl = process.env.SITE_URL;
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });

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

      if (path === '/api/me') return json(200, { user: session.user, name: session.name, sites: settings().siteHosts });
      if (path === '/api/overview' || path === '/api/ip') {
        const filters = parseFilters(path === '/api/ip' ? { ...params, site: 'all' } : params, clock());
        const queries = path === '/api/ip' ? ipQueries(filters, params.ip) : overviewQueries(filters);
        const names = Object.keys(queries);
        const results = await Promise.all(names.map((name) => query(queries[name])));
        return json(200, { filters, ...Object.fromEntries(names.map((name, i) => [name, results[i]])) });
      }
      if (path === '/api/requests') {
        const filters = parseFilters(params, clock());
        const rows = await query(requestsQuery(filters, params), { maxRows: 1000 });
        return json(200, { filters, requests: rows });
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
