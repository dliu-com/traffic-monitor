// status.dliu.com's health contract (status/HEALTH.md): /health, the /docs#health Health tab, the /docs/health redirect
// and /docs/health.md.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHandler } = require('../lambda/dashboard');
const { FUNCTIONS, CHECKS, runHealth, healthResponse } = require('../lambda/dashboard/health');
const { build } = require('../scripts/health-docs');

const loadPagesFunction = () => new Function(`${fs.readFileSync(path.join(__dirname, '..', 'functions', 'dashboard-pages.js'), 'utf8')}\nreturn handler;`)();

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const NOW = Date.UTC(2026, 10, 3, 23, 0, 0);
const HOUR = 3600 * 1000;
const source = JSON.parse(read('config/health.json'));

// Fake AWS clients: S3 answers by key, CloudWatch with one datapoint.
function fakes({ stats = NOW - HOUR, hosting = NOW - 24 * HOUR, run = { state: 'done', finished: new Date(NOW - HOUR).toISOString() }, invocations = 12, fail = {} } = {}) {
  const calls = [];
  const s3 = {
    send: async (command) => {
      const name = command.constructor.name;
      calls.push([name, command.input.Key]);
      if (fail[command.input.Key]) throw new Error('boom');
      if (name === 'HeadObjectCommand') return { LastModified: new Date(command.input.Key === 'stats/7d.json' ? stats : hosting) };
      if (name === 'GetObjectCommand') return { Body: { transformToString: async () => JSON.stringify(run) } };
      throw new Error(`unexpected ${name}`);
    },
  };
  const cloudwatch = {
    send: async (command) => {
      calls.push([command.constructor.name, command.input.MetricName]);
      if (fail.cloudwatch) throw new Error('boom');
      return { Datapoints: invocations == null ? [] : [{ Sum: invocations }] };
    },
  };
  return { s3, cloudwatch, calls, loadConfig: async () => { if (fail.config) throw new Error('boom'); return {}; } };
}

const statusOf = (body, key) => body.functions.find((f) => f.key === key);

describe('/health checks', () => {
  test('all pass: 200, application/health+json, cached 60 s, only the contract fields', async () => {
    const deps = fakes();
    const body = await runHealth(deps, NOW);
    expect(body).toEqual({
      status: 'pass',
      time: '2026-11-03T23:00:00Z',
      functions: FUNCTIONS.map(({ key, name }) => ({ key, name, status: 'pass' })),
    });
    const response = healthResponse(body);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/health+json');
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    // One cheap read per dependency: no S3 LIST, no Athena, no third parties.
    expect(deps.calls.map(([name]) => name).sort()).toEqual(['GetMetricStatisticsCommand', 'GetObjectCommand', 'HeadObjectCommand', 'HeadObjectCommand']);
  });

  test('stale files warn, then fail with 503', async () => {
    let body = await runHealth(fakes({ stats: NOW - 30 * HOUR }), NOW);
    expect(statusOf(body, 'public-stats')).toMatchObject({ status: 'warn', output: 'stale' });
    expect(body.status).toBe('warn');
    expect(healthResponse(body).statusCode).toBe(200);
    body = await runHealth(fakes({ stats: NOW - 60 * HOUR }), NOW);
    expect(statusOf(body, 'public-stats')).toMatchObject({ status: 'fail', output: 'stale' });
    expect(healthResponse(body).statusCode).toBe(503);
  });

  test('bot check: late or failed runs and an old hosting list', async () => {
    expect(statusOf(await runHealth(fakes({ run: { state: 'done', finished: new Date(NOW - 10 * HOUR).toISOString() } }), NOW), 'bot-check').status).toBe('warn');
    expect(statusOf(await runHealth(fakes({ run: { state: 'done', finished: new Date(NOW - 30 * HOUR).toISOString() } }), NOW), 'bot-check').status).toBe('fail');
    expect(statusOf(await runHealth(fakes({ run: { state: 'failed', finished: new Date(NOW - HOUR).toISOString() } }), NOW), 'bot-check')).toMatchObject({ status: 'warn', output: 'last run failed' });
    expect(statusOf(await runHealth(fakes({ hosting: NOW - 10 * 24 * HOUR }), NOW), 'bot-check')).toMatchObject({ status: 'warn', output: 'stale' });
    expect(statusOf(await runHealth(fakes({ fail: { 'hosting/asns.json': true } }), NOW), 'bot-check')).toMatchObject({ status: 'warn', output: 'read failed' });
    expect(statusOf(await runHealth(fakes({ fail: { 'bots/status.json': true } }), NOW), 'bot-check')).toMatchObject({ status: 'fail', output: 'read failed' });
  });

  test('no partitioner runs in 3 hours fails logging; errors become generic outputs', async () => {
    expect(statusOf(await runHealth(fakes({ invocations: null }), NOW), 'logging')).toMatchObject({ status: 'fail', output: 'no recent logs' });
    const body = await runHealth(fakes({ fail: { cloudwatch: true, config: true } }), NOW);
    expect(statusOf(body, 'logging')).toEqual({ key: 'logging', name: 'Request logging', status: 'fail', output: 'read failed' });
    expect(statusOf(body, 'signin')).toEqual({ key: 'signin', name: 'Microsoft sign-in', status: 'fail', output: 'read failed' });
    expect(JSON.stringify(body)).not.toMatch(/boom|Error|bucket|arn:/i);
  });

  test('a hanging dependency times out on its own and the answer still comes back', async () => {
    const deps = { ...fakes(), loadConfig: () => new Promise(() => {}), timeoutMs: 50 };
    const body = await runHealth(deps, NOW);
    expect(statusOf(body, 'signin')).toMatchObject({ status: 'fail', output: 'timeout' });
    expect(statusOf(body, 'logging').status).toBe('pass');
  });
});

describe('/health route', () => {
  // An event whose cookies, Authorization header and query string throw if anything reads them.
  function guardedEvent(method = 'GET') {
    const trap = (what) => () => { throw new Error(`/health read ${what}`); };
    const headers = { 'user-agent': 'dliu-status-bot/1.0' };
    Object.defineProperty(headers, 'authorization', { get: trap('authorization'), enumerable: true });
    Object.defineProperty(headers, 'cookie', { get: trap('cookie'), enumerable: true });
    const event = { rawPath: '/health', requestContext: { http: { method } }, headers };
    for (const field of ['cookies', 'queryStringParameters', 'rawQueryString', 'body']) Object.defineProperty(event, field, { get: trap(field) });
    return event;
  }

  test('GET and HEAD answer without reading cookies, the Authorization header or the query string', async () => {
    const deps = fakes();
    const handler = createHandler({ ...deps, now: () => NOW });
    for (const method of ['GET', 'HEAD']) {
      const response = await handler(guardedEvent(method));
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).status).toBe('pass');
      expect(response.headers['content-type']).toBe('application/health+json');
      expect(response.cookies).toBeUndefined();
    }
  });

  test('other methods get 405 and nothing is checked', async () => {
    const deps = fakes();
    const handler = createHandler({ ...deps, now: () => NOW });
    expect((await handler(guardedEvent('POST'))).statusCode).toBe(405);
    expect(deps.calls).toEqual([]);
  });

  test('the source of health.js reads no request data and makes no list, Athena or third-party call', () => {
    const code = read('lambda/dashboard/health.js');
    expect(code).not.toMatch(/\bevent\b|\.cookies|\.headers|\.authorization|queryString|ListObjects|client-athena|PutObject|DeleteObject|fetch\(/);
    expect(Object.keys(CHECKS).sort()).toEqual(FUNCTIONS.map((f) => f.key).sort());
  });
});

describe('/docs#health, the /docs/health redirect and /docs/health.md', () => {
  const { article, html, md } = build();
  const healthKeys = source.functions.filter((f) => f.health).map((f) => f.key);

  test('the Health tab and the Markdown are generated from config/health.json and up to date', () => {
    expect(read('web/docs.html')).toBe(html);
    expect(html).toContain(article);
    expect(fs.existsSync(path.join(ROOT, 'web/docs-health.html'))).toBe(false);
    expect(read('web/docs-health.md')).toBe(md);
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/health-docs.js'), '--check']);
  });

  test('the endpoint, the page and the Markdown list the same functions', () => {
    expect(FUNCTIONS).toEqual(source.functions.filter((f) => f.health).map((f) => ({ key: f.key, name: f.name[1] })));
    for (const { key, name } of source.functions) {
      expect(md).toContain(`| \`${key}\` | ${name[1]} |`);
      expect(article).toContain(`<tr><td data-zh="${name[0]}">${name[1]}</td>`);
      expect(article).toContain(`text-anchor="end" data-zh="${name[0]}">${name[1]}</text>`);
    }
    for (const key of healthKeys) expect(md).toContain(`"key": "${key}"`);
    for (const check of source.checks) expect(source.functions.map((f) => f.key)).toContain(check.function);
  });

  test('the Health tab shows rather than tells: big numbers, flows, a table and a chart', () => {
    expect(article.startsWith('    <article id="health" class="dl-docs" hidden>')).toBe(true);
    expect(article).toContain('<div class="dg-stats">');
    expect(article.match(/<div class="dg-stat" data-icon="/g).length).toBeGreaterThanOrEqual(4);
    expect(article).toContain(`<strong data-zh="${source.functions.length}">${source.functions.length}</strong><small data-zh="项功能被测试">functions tested</small>`);
    expect(article).toContain('<div class="dg-flow" role="list">');
    expect(article).toContain('<span class="dg-arrow">');
    expect(article).toContain('<div class="dg-flow dg-results" role="list">');
    for (const tone of ['good', 'warn', 'bad']) expect(article).toContain(`class="dg-step dg-${tone}"`);
    expect(article).toContain('<th data-zh="怎么测试">How it is tested</th>');
    expect(article).toContain('<figure class="dg chart health-chart">');
    expect(article.match(/<rect class="bar"/g).length).toBe(source.functions.length);
    expect(article).toContain('<h2 data-zh="没有测试的内容">What isn\'t tested</h2>');
    expect(article.trimEnd().endsWith('<p><a href="/docs/health.md" data-zh="给机器读的技术版本（Markdown）">Technical version for machines (Markdown)</a></p>\n    </article>')).toBe(true);
  });

  test('the Health tab has no exact technical details: no code, folded blocks, status codes, headers, content types or JSON', () => {
    expect(article).not.toMatch(/<details|<summary|<code|<pre|data-lang=/);
    const text = article.replace(/<[^>]*>/g, ' ');
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/\b(200|301|302|401|403|404|405|500|503)\b/);
    expect(text).not.toMatch(/application\/|text\/(html|markdown)|content-type|cache-control|authorization|max-age|\{|\}/i);
    expect(text).not.toMatch(/\b(GET|HEAD|POST|Location)\b/);
    for (const check of source.checks) {
      if (check.marker) expect(text).not.toContain(check.marker.replace(/"/g, '&quot;'));
      if (check.jsonKey) expect(text).not.toContain(`"${check.jsonKey}"`);
    }
    // High-level details are fine: which pages and endpoints are tested.
    expect(text).toContain('/health');
    expect(text).toContain('/auth/login');
  });

  test('the Health tab sits next to the other /docs tabs and loads its script', () => {
    expect(html).toContain('<a href="#security" data-tab="security" data-zh="安全">Security</a>\n      <a href="#health" data-tab="health" data-zh="健康">Health</a>\n    </nav>');
    expect(html).not.toMatch(/href="\/docs\/health"/);
    expect(read('web/docs.js')).toContain("import './docs-health.js';");
    expect(read('web/docs.js')).toContain("health: t('健康', 'Health'),");
    expect(read('web/docs-health.js')).toContain("document.getElementById('health')");
  });

  test('the old /docs/health URL answers 301 to /docs#health; /docs/health.md stays', () => {
    const fn = loadPagesFunction();
    for (const uri of ['/docs/health', '/docs/health/']) {
      const response = fn({ request: { uri, querystring: {} } });
      expect(response.statusCode).toBe(301);
      expect(response.headers.location.value).toBe('/docs#health');
    }
    expect(fn({ request: { uri: '/docs/health.md', querystring: {} } }).uri).toBe('/docs-health.md');
    expect(source.checks).toContainEqual(expect.objectContaining({ path: '/docs/health', status: 301, location: '/docs#health' }));
  });

  test('the Markdown has every technical detail unfolded, enough to implement the tests', () => {
    expect(md.startsWith('# traffic.dliu.com health checks\n')).toBe(true);
    for (const heading of ['## Functions', '## Guest checks', '## Health endpoint', '## Not tested', '## Rules']) expect(md).toContain(heading);
    expect(md).not.toContain('<details');
    for (const check of source.checks) expect(md).toContain(`| GET | https://traffic.dliu.com${check.path} | ${check.status} |`);
    expect(md).toContain('application/health+json');
    expect(md).toContain('dliu-status-bot/1.0 (+https://status.dliu.com/docs)');
    expect(md).toContain('Location starts with https://login.microsoftonline.com/');
    for (const item of source.untested) expect(md).toContain(`- ${item.detail}`);
  });

  test('the guest checks match what the site serves', () => {
    const marker = (p) => source.checks.find((c) => c.path === p).marker;
    expect(read('web/index.html')).toContain(marker('/'));
    expect(read('web/docs.html')).toContain(marker('/docs'));
    expect(article).toContain(marker('/docs'));
    expect(md).toContain(marker('/docs/health.md'));
    expect(read('functions/page-script.js')).toContain(marker('/t/s.js'));
  });
});
