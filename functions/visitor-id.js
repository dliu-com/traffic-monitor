// CloudFront Function (cloudfront-js-2.0), viewer-response.
// Gives each browser a long-lived random visitor ID shared across all subdomains.
// The COOKIE_DOMAIN placeholder is replaced at deploy time with the root domain (e.g. dliu.com).
// The ID is also written to the access log (viewer-response-log-data), so a visitor's first
// request, which has no cookie yet, is counted under the same ID as the rest of their visit.
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

function handler(event) {
  var request = event.request;
  var response = event.response;
  var existing = request.cookies && request.cookies[COOKIE_NAME];
  if (existing && /^[a-z0-9]{8,40}$/.test(existing.value)) {
    cf.logCustomData(existing.value);
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
  cf.logCustomData(id);
  return response;
}
