// The page script sites load from https://traffic.<root>/t/s.js (served by page-events.js).
// For each page view it reports how long the page was visible, how far it was scrolled, the screen size,
// the load time and the number of script errors. It sets no cookies and stores nothing: the dl_vid cookie the
// visitor function already set is sent with the report. Reports go out after 10 s, 30 s, 1, 2, 5 and 10 minutes
// of reading and whenever the page is hidden, each with the totals so far; the dashboard keeps the latest.
(function () {
  var w = window;
  var d = document;
  if (w.__dlTraffic) return;
  w.__dlTraffic = 1;
  var endpoint = '__ENDPOINT__';
  var marks = [10, 30, 60, 120, 300, 600];
  var view;
  var errors = 0;

  function newView() {
    view = { id: (Math.random().toString(36).slice(2) + '0000000000').slice(0, 10), path: location.pathname, seq: 0, shown: 0, total: 0, scroll: 0, mark: 0 };
    if (d.visibilityState === 'visible') view.shown = Date.now();
  }

  function seconds() {
    return Math.round((view.total + (view.shown ? Date.now() - view.shown : 0)) / 1000);
  }

  // How far down the page the bottom of the screen has been, in percent.
  function depth() {
    var height = Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
    var bottom = (w.pageYOffset || d.documentElement.scrollTop || 0) + w.innerHeight;
    return height > 0 ? Math.min(100, Math.round((bottom * 100) / height)) : 0;
  }

  function loadTime() {
    var nav = w.performance && performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    var end = nav ? nav.loadEventEnd || nav.domContentLoadedEventEnd : 0;
    return end > 0 ? Math.round(end) : '';
  }

  function send() {
    view.scroll = Math.max(view.scroll, depth());
    view.seq += 1;
    var url = endpoint + '?pv=' + view.id + '&n=' + view.seq + '&h=' + encodeURIComponent(location.hostname) +
      '&p=' + encodeURIComponent(view.path) + '&t=' + seconds() + '&s=' + view.scroll +
      '&sc=' + screen.width + 'x' + screen.height + 'x' + Math.round((w.devicePixelRatio || 1) * 100) +
      '&l=' + loadTime() + '&e=' + Math.min(errors, 999);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url)) return;
    } catch (e) { /* fall through */ }
    try {
      fetch(url, { method: 'POST', keepalive: true, mode: 'no-cors', credentials: 'include' });
    } catch (e) {
      new Image().src = url;
    }
  }

  function hidden() {
    if (view.shown) {
      view.total += Date.now() - view.shown;
      view.shown = 0;
      send();
    }
  }

  // Single-page sites change the path without loading a page: report the old view and start a new one.
  function route() {
    if (location.pathname === view.path) return;
    hidden();
    newView();
  }

  newView();
  d.addEventListener('visibilitychange', function () {
    if (d.visibilityState === 'visible') {
      if (!view.shown) view.shown = Date.now();
    } else {
      hidden();
    }
  });
  w.addEventListener('pagehide', hidden);
  w.addEventListener('scroll', function () { view.scroll = Math.max(view.scroll, depth()); }, { passive: true });
  w.addEventListener('error', function () { errors += 1; });
  w.addEventListener('unhandledrejection', function () { errors += 1; });
  w.addEventListener('popstate', route);
  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    history[name] = function () {
      var result = original.apply(this, arguments);
      route();
      return result;
    };
  });
  setInterval(function () {
    route();
    if (view.shown && view.mark < marks.length && seconds() >= marks[view.mark]) {
      view.mark += 1;
      send();
    }
  }, 2000);
})();
