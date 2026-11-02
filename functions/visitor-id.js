// CloudFront Function (cloudfront-js-2.0), viewer-response.
// Gives each browser a long-lived random visitor ID shared across all subdomains.
// The COOKIE_DOMAIN placeholder is replaced at deploy time with the root domain (e.g. dliu.com).
// The ID is also written to the access log (viewer-response-log-data), so a visitor's first
// request, which has no cookie yet, is counted under the same ID as the rest of their visit.
// When the site forwards CloudFront-Viewer-City (the shared dliu-traffic-geo origin request policy),
// the city is logged too, as "<id>.<hex of the city's UTF-8 bytes>". CloudFront URL-escapes log
// fields, so the value uses only characters it leaves alone.
// HTML responses ask Chromium browsers (Accept-CH) for their device model and system version, which they
// send on later requests; those are logged after the city as "_m<hex of the model>" and "_v<version>".
import cf from 'cloudfront';

var COOKIE_NAME = 'dl_vid';
var COOKIE_DOMAIN = '__COOKIE_DOMAIN__';
var MAX_AGE = 31536000;
var ACCEPT_CH = 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version';

function randomId() {
  var chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  var id = Date.now().toString(36);
  for (var i = 0; i < 16; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// CloudFront percent-encodes non-ASCII characters in the header; decode it, then hex-encode the
// UTF-8 bytes (encodeURIComponent gives %XX for every byte that is not plain ASCII).
function cityHex(request) {
  var header = request.headers['cloudfront-viewer-city'];
  if (!header || !header.value) return '';
  var value = header.value;
  try { value = decodeURIComponent(value); } catch (e) { /* keep the raw value */ }
  var encoded;
  try { encoded = encodeURIComponent(value.slice(0, 60)); } catch (e) { return ''; }
  var hex = '';
  for (var i = 0; i < encoded.length; i++) {
    if (encoded.charAt(i) === '%') {
      hex += encoded.substr(i + 1, 2).toLowerCase();
      i += 2;
    } else {
      hex += ('0' + encoded.charCodeAt(i).toString(16)).slice(-2);
    }
  }
  return hex;
}

// A client hint header's value is a quoted string, e.g. "SM-G996B" or "14.0.0".
function hint(request, name) {
  var header = request.headers[name];
  if (!header || !header.value) return '';
  var value = header.value.trim();
  if (value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') value = value.slice(1, -1);
  return value;
}

function hintsSuffix(request) {
  var suffix = '';
  var model = hint(request, 'sec-ch-ua-model');
  if (/^[A-Za-z0-9 ._()+-]{1,40}$/.test(model)) {
    suffix += '_m';
    for (var i = 0; i < model.length; i++) suffix += ('0' + model.charCodeAt(i).toString(16)).slice(-2);
  }
  var version = hint(request, 'sec-ch-ua-platform-version');
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){0,3}$/.test(version)) suffix += '_v' + version;
  return suffix;
}

function logVisit(id, request) {
  var hex = cityHex(request);
  cf.logCustomData((hex ? id + '.' + hex : id) + hintsSuffix(request));
}

function askForHints(response) {
  var type = response.headers['content-type'];
  if (type && /^text\/html/i.test(type.value) && !response.headers['accept-ch']) {
    response.headers['accept-ch'] = { value: ACCEPT_CH };
  }
}

function handler(event) {
  var request = event.request;
  var response = event.response;
  askForHints(response);
  var existing = request.cookies && request.cookies[COOKIE_NAME];
  if (existing && /^[a-z0-9]{8,40}$/.test(existing.value)) {
    logVisit(existing.value, request);
    return response;
  }

  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  var attributes = 'Path=/; Max-Age=' + MAX_AGE + '; Secure; HttpOnly; SameSite=Lax';
  if (host === COOKIE_DOMAIN || host.endsWith('.' + COOKIE_DOMAIN)) {
    attributes = 'Domain=.' + COOKIE_DOMAIN + '; ' + attributes;
  }

  var id = randomId();
  response.cookies = response.cookies || {};
  response.cookies[COOKIE_NAME] = { value: id, attributes: attributes };
  logVisit(id, request);
  return response;
}
