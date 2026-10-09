const fs = require('fs');
const path = require('path');

const logged = [];
const cf = { logCustomData: (value) => logged.push(value) };

function loadHandler(domain = 'dliu.com') {
  const code = fs.readFileSync(path.join(__dirname, '..', 'functions', 'visitor-id.js'), 'utf8')
    .replace('__COOKIE_DOMAIN__', domain);
  expect(code).toContain("import cf from 'cloudfront';");
  return new Function('cf', `${code.replace("import cf from 'cloudfront';", '')}\nreturn handler;`)(cf);
}

function event(host, cookies = {}) {
  return {
    request: { headers: host ? { host: { value: host } } : {}, cookies },
    response: { statusCode: 200, headers: {}, cookies: {} },
  };
}

describe('visitor-id CloudFront function', () => {
  const handler = loadHandler();

  test('sets a new shared-domain cookie when absent', () => {
    const response = handler(event('xiangqi.dliu.com'));
    const cookie = response.cookies.dl_vid;
    expect(cookie.value).toMatch(/^[a-z0-9]{8,40}$/);
    expect(cookie.attributes).toBe('Domain=.dliu.com; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax');
  });

  test('sets the cookie on the apex domain', () => {
    expect(handler(event('dliu.com')).cookies.dl_vid.attributes).toMatch(/^Domain=\.dliu\.com;/);
  });

  test('omits Domain for hosts outside the root domain', () => {
    const response = handler(event('d111.cloudfront.net'));
    expect(response.cookies.dl_vid.attributes).not.toMatch(/Domain=/);
    expect(handler(event('evildliu.com')).cookies.dl_vid.attributes).not.toMatch(/Domain=/);
  });

  test('leaves an existing valid cookie alone', () => {
    const response = handler(event('cyy.dliu.com', { dl_vid: { value: 'abc123def456' } }));
    expect(response.cookies.dl_vid).toBeUndefined();
  });

  test('logs the visitor id for existing and new visitors', () => {
    logged.length = 0;
    handler(event('cyy.dliu.com', { dl_vid: { value: 'abc123def456' } }));
    const fresh = handler(event('cyy.dliu.com')).cookies.dl_vid.value;
    handler(event('cyy.dliu.com', { dl_vid: { value: 'bad value;' } }));
    expect(logged.slice(0, 2)).toEqual(['abc123def456', fresh]);
    expect(logged).toHaveLength(3);
    expect(logged[2]).toMatch(/^[a-z0-9]+$/);
  });

  test('replaces a malformed cookie', () => {
    const response = handler(event('cyy.dliu.com', { dl_vid: { value: 'bad value;' } }));
    expect(response.cookies.dl_vid.value).toMatch(/^[a-z0-9]+$/);
  });

  test('generates distinct ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => handler(event('dliu.com')).cookies.dl_vid.value));
    expect(ids.size).toBe(200);
  });

  test('keeps other response cookies', () => {
    const e = event('home.dliu.com');
    e.response.cookies = { other: { value: '1' } };
    const response = handler(e);
    expect(response.cookies.other.value).toBe('1');
    expect(response.cookies.dl_vid).toBeDefined();
  });
});
