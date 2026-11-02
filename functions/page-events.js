// CloudFront Function (cloudfront-js-2.0), viewer-request, on the t/* behavior of the dashboard distribution.
//   GET /t/s.js  - the page script (page-script.js, inserted at deploy time as __SCRIPT__)
//   /t/e?...     - a page script report: checked, logged (viewer-request-log-data) and answered with 204
// Nothing reaches the origin. A report is logged as
//   1.<page view>.<report number>.<site>.<dl_vid or empty>.<seconds visible>.<scroll %>.<screen>.<load ms>.<errors>.<hex of the path>
// using only characters CloudFront leaves alone in log fields; anything that fails a check is not logged.
import cf from 'cloudfront';

var SCRIPT = __SCRIPT__;
// Host name -> site key, from config/sites.json.
var SITES = __SITES__;

function param(request, name) {
  var entry = request.querystring[name];
  if (!entry) return '';
  return entry.multiValue ? entry.multiValue[entry.multiValue.length - 1].value : entry.value;
}

function int(value, max) {
  if (!/^[0-9]{1,9}$/.test(value)) return -1;
  var n = parseInt(value, 10);
  return n <= max ? n : -1;
}

function hex(text) {
  var encoded = encodeURIComponent(text);
  var out = '';
  for (var i = 0; i < encoded.length; i++) {
    if (encoded.charAt(i) === '%') {
      out += encoded.substr(i + 1, 2).toLowerCase();
      i += 2;
    } else {
      out += ('0' + encoded.charCodeAt(i).toString(16)).slice(-2);
    }
  }
  return out;
}

// The page that sent the report must be on the site it names. Browsers always send Origin with the script's
// beacon and fetch reports (Referer with the image fallback), so a report with neither is not from a page.
function fromSite(request, host) {
  var origin = request.headers.origin || request.headers.referer;
  if (!origin) return false;
  var match = /^https:\/\/([^/:]+)/.exec(origin.value);
  return Boolean(match) && match[1].toLowerCase() === host;
}

function report(request) {
  var host = param(request, 'h').toLowerCase();
  var site = Object.prototype.hasOwnProperty.call(SITES, host) ? SITES[host] : null;
  if (!site || !fromSite(request, host)) return null;
  var path;
  try { path = decodeURIComponent(param(request, 'p')); } catch (e) { return null; }
  if (!/^\/[^\u0000-\u001f\u007f]{0,200}$/.test(path)) return null;
  var pv = param(request, 'pv');
  var seq = int(param(request, 'n'), 999);
  var secs = int(param(request, 't'), 86400);
  var scroll = int(param(request, 's'), 100);
  var screen = param(request, 'sc');
  var load = param(request, 'l');
  var errors = int(param(request, 'e'), 999);
  if (!/^[a-z0-9]{6,16}$/.test(pv) || seq < 1 || secs < 0 || scroll < 0 || errors < 0) return null;
  if (!/^[0-9]{2,5}x[0-9]{2,5}x[0-9]{2,4}$/.test(screen)) screen = '';
  if (load !== '' && int(load, 600000) < 0) load = '';
  var cookie = request.cookies.dl_vid;
  var vid = cookie && /^[a-z0-9]{8,40}$/.test(cookie.value) ? cookie.value : '';
  var pathHex = hex(path);
  // Log fields hold 800 bytes; very long non-ASCII paths are not logged.
  if (pathHex.length > 500) return null;
  return ['1', pv, seq, site, vid, secs, scroll, screen, load, errors, pathHex].join('.');
}

function handler(event) {
  var request = event.request;
  if (request.uri === '/t/s.js' && (request.method === 'GET' || request.method === 'HEAD')) {
    return {
      statusCode: 200,
      statusDescription: 'OK',
      headers: {
        'content-type': { value: 'application/javascript; charset=utf-8' },
        'cache-control': { value: 'public, max-age=3600' },
        'x-content-type-options': { value: 'nosniff' },
      },
      body: SCRIPT,
    };
  }
  if (request.uri === '/t/e') {
    var line = report(request);
    if (line) cf.logCustomData(line);
    return { statusCode: 204, statusDescription: 'No Content', headers: { 'cache-control': { value: 'no-store' } } };
  }
  return { statusCode: 404, statusDescription: 'Not Found', headers: { 'cache-control': { value: 'no-store' } } };
}
