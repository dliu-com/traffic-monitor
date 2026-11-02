// Reading a user agent: which browser (or in-app browser) and which device sent a request.
// Kept free of DOM code so it can be tested on its own (test/ua.test.js).

export const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python|httpclient|http-client|headless|monitor|preview|scanner|go-http|java\/|okhttp|axios|node-fetch|facebookexternalhit|lighthouse/i;

// In-app browsers name their app in the user agent (MicroMessenger is WeChat's internal name), with the app's
// version where it has one. WeCom also sends MicroMessenger, so it is checked first.
const APPS = [
  [/wxwork\/(\d+\.\d+)?/i, 'WeCom'], [/MicroMessenger\/(\d+\.\d+)?/, 'WeChat'], [/ QQ\/(\d+\.\d+)?/, 'QQ'],
  [/MQQBrowser\/(\d+\.\d+)?/, 'QQ Browser'], [/DingTalk\/(\d+\.\d+)?/, 'DingTalk'], [/AlipayClient\/(\d+\.\d+)?/, 'Alipay'],
  [/Weibo/, 'Weibo'], [/aweme|BytedanceWebview|musical_ly|TikTok/i, 'TikTok/Douyin'], [/baiduboxapp\/(\d+\.\d+)?/, 'Baidu'],
  [/UCBrowser\/(\d+\.\d+)?/, 'UC Browser'], [/XiaoHongShu|discover\/\d/, 'Xiaohongshu'], [/FBAV\/(\d+)|FBAN\//, 'Facebook'],
  [/Instagram (\d+)?/, 'Instagram'], [/LinkedInApp/, 'LinkedIn'], [/ Line\/(\d+\.\d+)?/, 'LINE'], [/WhatsApp\/(\d+\.\d+)?/, 'WhatsApp'],
  [/Snapchat\/(\d+\.\d+)?/, 'Snapchat'], [/GSA\/(\d+)?/, 'Google app'], [/YaBrowser\/(\d+)?/, 'Yandex'], [/DuckDuckGo\/(\d+)?/, 'DuckDuckGo'],
];

const BROWSERS = [
  [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'], [/OPR\/(\d+)|Opera/, 'Opera'], [/SamsungBrowser\/(\d+(?:\.\d+)?)/, 'Samsung Internet'],
  [/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'], [/(?:Chrome|CriOS)\/(\d+)/, 'Chrome'], [/ Version\/(\d+(?:\.\d+)?)[^ ]*(?: Mobile\/\S+)? Safari\//, 'Safari'],
];

const TV = /SmartTV|SMART-TV|Tizen[^;)]*TV|Web0S|webOS|AppleTV|GoogleTV|Android TV|BRAVIA|\bAFT[A-Z]|CrKey|HbbTV|Roku/i;

// "Bot: Googlebot", "WeChat 8.0", "Chrome 131", "Safari 18.6"
export function describeBrowser(ua) {
  if (!ua) return '';
  if (ua === '-') return 'No browser name';
  if (BOT_UA.test(ua)) {
    const named = ua.match(/([A-Za-z0-9._-]*(?:bot|crawler|spider|headless)[A-Za-z0-9._-]*)/i);
    return `Bot: ${named ? named[1] : ua.split(/[/ ]/)[0]}`;
  }
  for (const [pattern, name] of [...APPS, ...BROWSERS]) {
    const match = ua.match(pattern);
    if (match) return match[1] ? `${name} ${match[1]}` : name;
  }
  if (/Safari\//.test(ua)) return 'Safari';
  return /iPhone|iPad/.test(ua) ? 'In-app browser' : /^Mozilla\//.test(ua) ? 'Unknown browser' : ua.split(/[/ ]/)[0];
}

// The phone model an Android user agent names: in-app browsers and older browsers send it ("V2206A",
// "SM-G996B"); Chrome now sends "K" instead, and with it a frozen "Android 10".
function androidModel(ua) {
  const match = ua.match(/Android [\d.]+;(?: [a-z]{2}[-_][A-Za-z]{2};)?(?: U;)? ([^;)]+?)(?: B(?:uild|ulid)\/[^;)]*)?[;)]/);
  const model = match && match[1].trim();
  return model && !/^(K|wv|Linux|Mobile|U)$/i.test(model) && model.length <= 40 ? model : null;
}

function iosVersion(ua, os) {
  // Safari 26 and later freeze the OS version at 18.6; its own version matches the system.
  const safari = !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) && ua.match(/ Version\/(\d+(?:\.\d+)?)[^ ]* Mobile\/.* Safari\//);
  const system = ua.match(/ OS (\d+)_(\d+)/);
  const version = safari ? safari[1] : system ? `${system[1]}.${system[2]}` : '';
  const name = os === 'iPad' && (!version || parseFloat(version) >= 13) ? 'iPadOS' : 'iOS';
  return version ? `${name} ${version}` : name;
}

// Client hints as the dashboard queries return them: "<model>|<system version>", either may be empty.
export function parseHints(hints) {
  const [model = '', version = ''] = typeof hints === 'string' ? hints.split('|') : [];
  return {
    model: /^[A-Za-z0-9 ._()+-]{1,40}$/.test(model) ? model.trim() : '',
    version: /^\d{1,3}(\.\d{1,3}){0,3}$/.test(version) ? version : '',
  };
}

// The real system version from the Sec-CH-UA-Platform-Version hint. Windows reports 13 and up for Windows 11,
// 1 to 10 for Windows 10 and 0 for older ones.
function hintedSystem(system, version) {
  if (!version) return null;
  const [major, minor] = version.split('.').map(Number);
  if (system === 'Windows') return major >= 13 ? 'Windows 11' : major >= 1 ? 'Windows 10' : 'Windows';
  if (system === 'macOS') return `macOS ${major >= 11 ? major : `${major}.${minor || 0}`}`;
  if (system === 'Android') return `Android ${major}`;
  return null;
}

// The kind of device, its model where the user agent or client hints name one, and its system:
// "iPhone · iOS 18.6", "Phone · V2206A · Android 13", "Tablet · Android", "Desktop · Windows 11", "TV · webOS".
// Phones other than Android never send their model, and some versions are frozen: macOS always says 10.15.7,
// Windows 10 and 11 both say NT 10.0, and Chrome on Android says Android 10, so those are left out unless
// Chrome sent the real ones as client hints (`hints`, see parseHints).
export function describeDevice(ua, hints) {
  if (!ua || ua === '-' || BOT_UA.test(ua)) return '';
  const hinted = parseHints(hints);
  if (TV.test(ua)) {
    const system = /Tizen/i.test(ua) ? 'Tizen' : /Web0S|webOS/i.test(ua) ? 'webOS' : /AppleTV/.test(ua) ? 'tvOS'
      : /Roku/i.test(ua) ? 'Roku' : /Android|GoogleTV|CrKey|AFT[A-Z]/.test(ua) ? 'Android' : '';
    return system ? `TV · ${system}` : 'TV';
  }
  if (/iPhone|iPod/.test(ua)) return `iPhone · ${iosVersion(ua, 'iPhone')}`;
  if (/iPad/.test(ua)) return `iPad · ${iosVersion(ua, 'iPad')}`;
  if (/Android/.test(ua)) {
    const model = hinted.model || androidModel(ua);
    const version = ua.match(/Android (\d+(?:\.\d+)?)/);
    const frozen = /Android 10; K\)/.test(ua);
    const system = hintedSystem('Android', hinted.version) || (version && !frozen ? `Android ${version[1]}` : 'Android');
    return [/Mobile|Phone/.test(ua) ? 'Phone' : 'Tablet', model, system].filter(Boolean).join(' · ');
  }
  const desktop = /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux|X11/.test(ua) ? 'Linux' : '';
  return desktop ? `Desktop · ${hintedSystem(desktop, hinted.version) || desktop}` : '';
}
