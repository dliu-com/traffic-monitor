const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'functions', 'dashboard-pages.js'), 'utf8');
const handler = new Function(`${code}\nreturn handler;`)();
const uriFor = (uri) => handler({ request: { uri } }).uri;

describe('dashboard-pages CloudFront function', () => {
  test.each([
    ['/about', '/about.html'],
    ['/about/', '/about.html'],
    ['/security', '/security.html'],
    ['/security/', '/security.html'],
    ['/site', '/site.html'],
    ['/ip/', '/ip.html'],
  ])('maps %s to %s', (uri, expected) => {
    expect(uriFor(uri)).toBe(expected);
  });

  test.each(['/', '/about.html', '/home.js', '/ips', '/api/me', '/auth/login', '/abouts', '/constructor', '/__proto__'])('leaves %s alone', (uri) => {
    expect(uriFor(uri)).toBe(uri);
  });
});
