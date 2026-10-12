// CloudFront Function (cloudfront-js-2.0), viewer-response.
// Gives each browser a long-lived random visitor ID shared across all subdomains.
// The COOKIE_DOMAIN placeholder is replaced at deploy time with the root domain (e.g. dliu.com).
// The ID is also written to the access log (viewer-response-log-data), so a visitor's first
// request, which has no cookie yet, is counted under the same ID as the rest of their visit.
// When the site forwards CloudFront-Viewer-City (the shared dliu-traffic-geo origin request policy),
// the city is logged too, as "<id>.<hex of the city's UTF-8 bytes>". CloudFront URL-escapes log
// fields, so the value uses only characters it leaves alone.
import cf from 'cloudfront';

var COOKIE_NAME = 'dl_vid';
var COOKIE_DOMAIN = '__COOKIE_DOMAIN__';
var MAX_AGE = 31536000;

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

function logVisit(id, request) {
  var hex = cityHex(request);
  cf.logCustomData(hex ? id + '.' + hex : id);
}

function handler(event) {
  var request = event.request;
  var response = event.response;
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
