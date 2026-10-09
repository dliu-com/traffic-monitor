// CloudFront Function (cloudfront-js-2.0), viewer-request on the dashboard's default behavior.
// Serves the public info pages at clean URLs: /about -> /about.html, /security -> /security.html.
var PAGES = { '/about': '/about.html', '/security': '/security.html' };

function handler(event) {
  var request = event.request;
  var uri = request.uri.length > 1 && request.uri.charAt(request.uri.length - 1) === '/' ? request.uri.slice(0, -1) : request.uri;
  if (Object.prototype.hasOwnProperty.call(PAGES, uri)) request.uri = PAGES[uri];
  return request;
}
