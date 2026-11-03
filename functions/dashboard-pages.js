// CloudFront Function (cloudfront-js-2.0), viewer-request on the dashboard's default behavior.
// Serves pages at clean URLs: /docs -> /docs.html, /site?site=x -> /site.html, /ip?ip=x -> /ip.html,
// /visitor?visitor=x -> /visitor.html, /page?site=x&path=/y -> /page.html, /bots -> /bots.html,
// /abuse-check -> /abuse-check.html, /docs/health -> /docs-health.html, /docs/health.md -> /docs-health.md.
// The old docs pages (/about, /detect-bot, /cost, /security) redirect to their tab on /docs.
var PAGES = { '/docs': '/docs.html', '/docs/health': '/docs-health.html', '/docs/health.md': '/docs-health.md', '/bots': '/bots.html', '/abuse-check': '/abuse-check.html', '/site': '/site.html', '/ip': '/ip.html', '/visitor': '/visitor.html', '/page': '/page.html' };
var MOVED = { '/about': '/docs', '/detect-bot': '/docs#bot-detection', '/cost': '/docs#cost', '/security': '/docs#security' };

function handler(event) {
  var request = event.request;
  var uri = request.uri.length > 1 && request.uri.charAt(request.uri.length - 1) === '/' ? request.uri.slice(0, -1) : request.uri;
  if (Object.prototype.hasOwnProperty.call(MOVED, uri)) {
    return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: MOVED[uri] }, 'cache-control': { value: 'max-age=86400' } } };
  }
  if (Object.prototype.hasOwnProperty.call(PAGES, uri)) request.uri = PAGES[uri];
  return request;
}
