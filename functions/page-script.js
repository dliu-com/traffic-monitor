// The page script sites load from https://traffic.<root>/t/s.js (served by page-events.js).
// For each page view it reports how long the page was visible, how far it was scrolled, the screen size,
// the load time and the number of script errors. It sets no cookies and stores nothing: the dl_vid cookie the
// visitor function already set is sent with the report. Reports go out after 10 s, 30 s, 1, 2, 5 and 10 minutes
// of reading and whenever the page is hidden, each with the totals so far; the dashboard keeps the latest.
// The first view counts from when the page started loading (as GA4 does), not from when this script arrived.
// The page comes first: every callback swallows its own errors, nothing waits for a report, and scrolling
// is measured at most once per frame. If traffic.<root> is down, the page behaves as if the script was absent.
(function () {
  try {
    var w = window;
    var d = document;
    if (w.__dlTraffic) return;
    w.__dlTraffic = 1;
    var endpoint = '__ENDPOINT__';
    var marks = [10, 30, 60, 120, 300, 600];
    var view;
    var errors = 0;
    var measuring = 0;

    // Runs fn, never letting an error reach the page.
    var safe = function (fn) {
      return function () {
        try { fn(); } catch (e) { /* ignore */ }
      };
    };

    // When the page started loading: navigation start, or when a prerendered page was shown.
    var pageStart = function () {
      var p = w.performance;
      if (!p || !p.now) return Date.now();
      var nav = p.getEntriesByType ? p.getEntriesByType('navigation')[0] : null;
      var activated = nav && nav.activationStart > 0 ? nav.activationStart : 0;
      return Math.min(Date.now(), Date.now() - p.now() + activated);
    };

    var newView = function (first) {
      view = { id: (Math.random().toString(36).slice(2) + '0000000000').slice(0, 10), path: location.pathname, seq: 0, shown: 0, total: 0, scroll: 0, mark: 0 };
      if (d.visibilityState === 'visible') view.shown = first ? pageStart() : Date.now();
    };

    var seconds = function () {
      return Math.round((view.total + (view.shown ? Date.now() - view.shown : 0)) / 1000);
    };

    // How far down the page the bottom of the screen has been, in percent.
    var measure = function () {
      measuring = 0;
      var height = Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
      var bottom = (w.pageYOffset || d.documentElement.scrollTop || 0) + w.innerHeight;
      if (height > 0) view.scroll = Math.max(view.scroll, Math.min(100, Math.round((bottom * 100) / height)));
    };

    var loadTime = function () {
      var p = w.performance;
      var nav = p && p.getEntriesByType ? p.getEntriesByType('navigation')[0] : null;
      var end = nav ? nav.loadEventEnd || nav.domContentLoadedEventEnd : 0;
      return end > 0 ? Math.round(end) : '';
    };

    // Fire and forget: a report that fails is simply lost.
    var send = function () {
      measure();
      view.seq += 1;
      var url = endpoint + '?pv=' + view.id + '&n=' + view.seq + '&h=' + encodeURIComponent(location.hostname) +
        '&p=' + encodeURIComponent(view.path) + '&t=' + seconds() + '&s=' + view.scroll +
        '&sc=' + screen.width + 'x' + screen.height + 'x' + Math.round((w.devicePixelRatio || 1) * 100) +
        '&l=' + loadTime() + '&e=' + Math.min(errors, 999);
      try {
        if (navigator.sendBeacon && navigator.sendBeacon(url)) return;
      } catch (e) { /* fall through */ }
      try {
        w.fetch(url, { method: 'POST', keepalive: true, mode: 'no-cors', credentials: 'include' }).catch(function () { /* lost */ });
      } catch (e) {
        try { new Image().src = url; } catch (e2) { /* lost */ }
      }
    };

    var hidden = function () {
      if (view.shown) {
        view.total += Date.now() - view.shown;
        view.shown = 0;
        send();
      }
    };

    // Single-page sites change the path without loading a page: report the old view and start a new one.
    var route = function () {
      if (location.pathname === view.path) return;
      hidden();
      newView();
    };

    newView(1);
    d.addEventListener('visibilitychange', safe(function () {
      if (d.visibilityState === 'visible') {
        if (!view.shown) view.shown = Date.now();
      } else {
        hidden();
      }
    }));
    w.addEventListener('pagehide', safe(hidden));
    w.addEventListener('scroll', safe(function () {
      if (measuring) return;
      measuring = 1;
      if (w.requestAnimationFrame) w.requestAnimationFrame(safe(measure));
      else setTimeout(safe(measure), 100);
    }), { passive: true });
    w.addEventListener('error', function () { errors += 1; });
    w.addEventListener('unhandledrejection', function () { errors += 1; });
    w.addEventListener('popstate', safe(route));
    var onRoute = safe(route);
    ['pushState', 'replaceState'].forEach(function (name) {
      var original = history[name];
      if (typeof original !== 'function') return;
      history[name] = function () {
        var result = original.apply(this, arguments);
        onRoute();
        return result;
      };
    });
    setInterval(safe(function () {
      route();
      if (view.shown && view.mark < marks.length && seconds() >= marks[view.mark]) {
        view.mark += 1;
        send();
      }
    }), 2000);
  } catch (e) { /* the page is unaffected */ }
})();
