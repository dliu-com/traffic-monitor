import { pageEventsSource } from '../lib/traffic-monitor-stack';

const SITES = [{ key: 'blog', host: 'blog.example.com' }, { key: 'cyy', host: 'cyy.example.com' }];
const ENDPOINT = 'https://traffic.example.com/t/e';

function load() {
  const code = pageEventsSource(SITES).split('__ENDPOINT__').join(ENDPOINT);
  const logged: string[] = [];
  expect(code).toContain("import cf from 'cloudfront';");
  const handler = new Function('cf', `${code.replace("import cf from 'cloudfront';", '')}\nreturn handler;`)({
    logCustomData: (value: string) => logged.push(value),
  });
  return { code, handler, logged };
}

type Query = Record<string, string>;
function request(uri: string, query: Query = {}, headers: Record<string, string> = {}, cookies: Record<string, string> = {}, method = 'POST') {
  return {
    request: {
      uri,
      method,
      querystring: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, { value: v }])),
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, { value: v }])),
      cookies: Object.fromEntries(Object.entries(cookies).map(([k, v]) => [k, { value: v }])),
    },
  };
}

const GOOD: Query = { pv: 'abc123def', n: '2', h: 'blog.example.com', p: '%2F2026103100', t: '42', s: '87', sc: '390x844x300', l: '812', e: '0' };
const ORIGIN = { origin: 'https://blog.example.com' };

// Runs the page script against a fake browser in which the traffic site is down.
function runScript(body: string, performance?: unknown) {
  const listeners: Record<string, Array<(e?: unknown) => void>> = {};
  const timers: Array<() => void> = [];
  const frames: Array<() => void> = [];
  const pushed: string[] = [];
  const rejections: unknown[] = [];
  const sent: string[] = [];
  let layouts = 0;
  const location = { pathname: '/a', hostname: 'blog.example.com' };
  const on = (type: string, fn: (e?: unknown) => void) => { (listeners[type] = listeners[type] || []).push(fn); };
  const history = {
    pushState(_s: unknown, _t: string, url: string) { pushed.push(url); location.pathname = url; return 'done'; },
    replaceState() { return undefined; },
  };
  const document = {
    visibilityState: 'visible',
    documentElement: { get scrollHeight(): number { layouts += 1; if (layouts === 1) throw new Error('layout failed'); return 2000; }, scrollTop: 0 },
    body: null,
    addEventListener: on,
  };
  const window = {
    addEventListener: on,
    performance,
    innerHeight: 800,
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    fetch: (url: string) => { sent.push(url); const p = Promise.reject(new Error('down')); p.catch(() => undefined); return { catch: (f: (e: unknown) => void) => p.catch(f) }; },
  };
  const navigator = { sendBeacon: () => { throw new Error('beacon failed'); } };
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  new Function('window', 'document', 'location', 'history', 'navigator', 'screen', 'performance', 'setInterval', 'setTimeout', 'Image', body)(
    window, document, location, history, navigator, { width: 390, height: 844 }, undefined,
    (fn: () => void) => timers.push(fn), (fn: () => void) => frames.push(fn), function Image() { throw new Error('no images'); });
  return { listeners, timers, frames, pushed, sent, history, location, rejections, done: () => process.off('unhandledRejection', onRejection) };
}

describe('page-events CloudFront function', () => {
  test('the page script never lets an error or a failed report reach the page', async () => {
    const { handler } = load();
    const page = runScript(handler(request('/t/s.js', {}, {}, {}, 'GET')).body);
    const fire = (type: string) => { for (const fn of page.listeners[type] || []) expect(() => fn()).not.toThrow(); };
    fire('scroll');
    fire('scroll');
    expect(page.frames).toHaveLength(1);
    expect(() => page.frames[0]()).not.toThrow();
    expect(page.history.pushState(null, '', '/b')).toBe('done');
    expect(page.pushed).toEqual(['/b']);
    for (const tick of page.timers) expect(() => tick()).not.toThrow();
    fire('pagehide');
    fire('visibilitychange');
    await new Promise((resolve) => setTimeout(resolve, 10));
    page.done();
    expect(page.sent.length).toBeGreaterThan(0);
    expect(page.sent[0]).toContain('&p=%2Fa&');
    expect(page.rejections).toEqual([]);
  });

  test('the first view counts from when the page started loading, not when the script arrived', async () => {
    const { handler } = load();
    const performance = { now: () => 4200, getEntriesByType: () => [{ activationStart: 0 }] };
    const page = runScript(handler(request('/t/s.js', {}, {}, {}, 'GET')).body, performance);
    for (const fn of page.listeners.scroll) fn();
    page.frames[0](); // the fake page's first layout read fails on purpose
    for (const fn of page.listeners.pagehide) fn();
    await new Promise((resolve) => setTimeout(resolve, 10));
    page.done();
    expect(page.sent[0]).toMatch(/&t=4&/);
  });

  test('fits within the CloudFront Functions size limit', () => {
    expect(Buffer.byteLength(load().code.split(ENDPOINT).join('https://traffic.dliu.com/t/e'))).toBeLessThan(10240);
  });

  test('serves the page script with the report URL filled in', () => {
    const { handler } = load();
    const response = handler(request('/t/s.js', {}, {}, {}, 'GET'));
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type'].value).toMatch(/javascript/);
    expect(response.body).toContain(ENDPOINT);
    expect(response.body).not.toContain('__ENDPOINT__');
    expect(() => new Function(response.body)).not.toThrow();
  });

  test('logs a valid report with the visitor cookie and hex path', () => {
    const { handler, logged } = load();
    const response = handler(request('/t/e', GOOD, ORIGIN, { dl_vid: 'visitor0001' }));
    expect(response.statusCode).toBe(204);
    const path = Buffer.from('/2026103100').toString('hex');
    expect(logged).toEqual([`1.abc123def.2.blog.visitor0001.42.87.390x844x300.812.0.${path}`]);
  });

  test('hex-encodes non-ASCII paths as UTF-8', () => {
    const { handler, logged } = load();
    handler(request('/t/e', { ...GOOD, p: encodeURIComponent('/文章 1') }, ORIGIN));
    expect(logged[0].split('.').pop()).toBe(Buffer.from('/文章 1', 'utf8').toString('hex'));
    expect(logged[0].split('.')[4]).toBe('');
  });

  test('blanks optional fields that fail their checks', () => {
    const { handler, logged } = load();
    handler(request('/t/e', { ...GOOD, sc: 'big', l: '9999999' }, ORIGIN, { dl_vid: 'BAD!' }));
    expect(logged[0].split('.').slice(4, 9)).toEqual(['', '42', '87', '', '']);
  });

  test.each([
    ['an unknown site', { h: 'evil.example.net' }, ORIGIN],
    ['a page on another site', {}, { origin: 'https://cyy.example.com' }],
    ['a referer on another host', {}, { referer: 'https://evil.example.net/x' }],
    ['a bad page view id', { pv: 'a.b' }, ORIGIN],
    ['a missing report number', { n: '0' }, ORIGIN],
    ['too many seconds', { t: '86401' }, ORIGIN],
    ['scroll over 100', { s: '101' }, ORIGIN],
    ['a relative path', { p: 'x' }, ORIGIN],
    ['control characters in the path', { p: '%2Fa%0Ab' }, ORIGIN],
    ['a malformed path', { p: '%E0%A4%A' }, ORIGIN],
    ['a very long path', { p: '/' + 'a'.repeat(250) }, ORIGIN],
  ])('answers 204 but does not log %s', (_name, query, headers) => {
    const { handler, logged } = load();
    expect(handler(request('/t/e', { ...GOOD, ...query }, headers)).statusCode).toBe(204);
    expect(logged).toEqual([]);
  });

  test('accepts a report without Origin or Referer', () => {
    const { handler, logged } = load();
    handler(request('/t/e', GOOD));
    expect(logged).toHaveLength(1);
  });

  test('answers 404 to anything else', () => {
    const { handler, logged } = load();
    expect(handler(request('/t/other', GOOD, ORIGIN)).statusCode).toBe(404);
    expect(handler(request('/t/s.js', {}, {}, {}, 'POST')).statusCode).toBe(404);
    expect(logged).toEqual([]);
  });
});
