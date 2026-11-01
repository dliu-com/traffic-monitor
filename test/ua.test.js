const fs = require('fs');
const path = require('path');

// web/ua.js is a browser ES module with no imports; load it by dropping its export keywords.
const code = fs.readFileSync(path.join(__dirname, '..', 'web', 'ua.js'), 'utf8').replace(/^export /gm, '');
const { describeBrowser, describeDevice } = new Function(`${code}\nreturn { describeBrowser, describeDevice };`)();

const cases = [
  ['Mozilla/5.0 (Linux; Android 13; V2206A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.62 Mobile Safari/537.36 MicroMessenger/8.0.42.2340(0x28002A36) Process/tools WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
    'WeChat 8.0', 'Phone · V2206A · Android 13'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x1800323c) NetType/WIFI Language/zh_CN',
    'WeChat 8.0', 'iPhone · iOS 14.6'],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'Chrome 131', 'Phone · Android'],
  ['Mozilla/5.0 (Linux; Android 12; SM-G996B Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36',
    'Chrome 120', 'Phone · SM-G996B · Android 12'],
  ['Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Chrome 124', 'Tablet · SM-X710 · Android 13'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    'Safari 26.0', 'iPhone · iOS 26.0'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
    'Chrome 126', 'iPhone · iOS 17.5'],
  ['Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    'Safari 17.4', 'iPad · iPadOS 17.4'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    'Safari 18.1', 'Desktop · macOS'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    'Edge 131', 'Desktop · Windows'],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox 132', 'Desktop · Linux'],
  ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome 130', 'Desktop · ChromeOS'],
  ['Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager', 'Chrome 87', 'TV · webOS'],
  ['Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36', 'Safari', 'TV · Tizen'],
  ['Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', 'Chrome 120', 'TV · Android'],
  ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Bot: Googlebot', ''],
  ['Mozilla/5.0 (Linux; Android 7.0; SM-G892A Bulid/NRD90M; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/60.0.3112.107 Mobile Safari/537.36',
    'Chrome 60', 'Phone · SM-G892A · Android 7.0'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Unknown browser', 'Desktop · Windows'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36', 'Bot: HeadlessChrome', ''],
  ['-', 'No browser name', ''],
  ['', '', ''],
];

describe('user agent', () => {
  test.each(cases)('%s', (ua, browser, device) => {
    expect(describeBrowser(ua)).toBe(browser);
    expect(describeDevice(ua)).toBe(device);
  });

  test('a long or odd model is not shown', () => {
    expect(describeDevice(`Mozilla/5.0 (Linux; Android 14; ${'X'.repeat(50)}) Chrome/120.0 Mobile Safari/537.36`)).toBe('Phone · Android 14');
  });
});
