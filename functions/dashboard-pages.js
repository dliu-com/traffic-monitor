// CloudFront Function (cloudfront-js-2.0), viewer-request on the dashboard's default behavior.
// Serves pages at clean URLs: /about -> /about.html, /site?site=x -> /site.html, /ip?ip=x -> /ip.html, etc.
var PAGES = { '/about': '/about.html', '/security': '/security.html', '/site': '/site.html', '/ip': '/ip.html' };

function handler(event) {
  var request = event.request;
  var uri = request.uri.length > 1 && request.uri.charAt(request.uri.length - 1) === '/' ? request.uri.slice(0, -1) : request.uri;
  if (Object.prototype.hasOwnProperty.call(PAGES, uri)) request.uri = PAGES[uri];
  return request;
}
