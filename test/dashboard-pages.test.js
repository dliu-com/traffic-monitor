const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'functions', 'dashboard-pages.js'), 'utf8');
const handler = new Function(`${code}\nreturn handler;`)();
const uriFor = (uri) => handler({ request: { uri } }).uri;

describe('dashboard-pages CloudFront function', () => {
  test.each([
    ['/docs', '/docs.html'],
    ['/docs/', '/docs.html'],
    ['/site', '/site.html'],
    ['/ip/', '/ip.html'],
    ['/visitor', '/visitor.html'],
    ['/page', '/page.html'],
    ['/bots', '/bots.html'],
    ['/abuse-check', '/abuse-check.html'],
    ['/docs/health', '/docs-health.html'],
    ['/docs/health/', '/docs-health.html'],
    ['/docs/health.md', '/docs-health.md'],
  ])('maps %s to %s', (uri, expected) => {
    expect(uriFor(uri)).toBe(expected);
  });

  test.each(['/', '/docs.html', '/about.html', '/docs/api', '/docss', '/home.js', '/ips', '/pages', '/api/me', '/auth/login', '/abouts', '/constructor', '/__proto__'])('leaves %s alone', (uri) => {
    expect(uriFor(uri)).toBe(uri);
  });

  test.each([
    ['/about', '/docs'],
    ['/about/', '/docs'],
    ['/detect-bot', '/docs#bot-detection'],
    ['/cost', '/docs#cost'],
    ['/security/', '/docs#security'],
  ])('redirects the old %s to %s', (uri, location) => {
    const response = handler({ request: { uri } });
    expect(response.statusCode).toBe(301);
    expect(response.headers.location.value).toBe(location);
  });
});
