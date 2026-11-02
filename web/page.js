import {
  $, botsNote, botToggle, buckets, card, chart, countryName, countryNote, countryShort, el, filters, fmt, formatTime,
  ipLink, isBot, kpis, pagedTable, pageLink, part, periodBar, periodText, series, setStatus, siteLink, siteName,
  siteUrl, start, state, staticTable, uaColumns, visitorLink, widget,
} from './dash.js';

// One page of one site: who viewed it and from which IP addresses.
const page = $('page');
const query = new URLSearchParams(location.search);
const site = query.get('site') || '';
const path = query.get('path') || '';

const home = el('a', { text: 'All sites' });
const siteCrumb = el('a');
const openLink = el('a', { target: '_blank', rel: 'noopener noreferrer', text: 'Open page ↗' });
const periodNote = el('p', { class: 'period-note' });
const kpiBox = el('div', { class: 'kpi-box' });
const overTime = card('Views over time');
const note = countryNote(load);
const scope = () => ({ site, path, ...filters() });

// What each “Arrived via” value means (others are the host of the page the link was on).
const SOURCE_HELP = {
  'WeChat Moments': 'Opened from a WeChat Moments post (the link had from=timeline)',
  'WeChat chat': 'Opened from a one-to-one WeChat chat (from=singlemessage)',
  'WeChat group': 'Opened from a WeChat group chat (from=groupmessage)',
  WeChat: 'Opened in WeChat from a link without a share tag (e.g. a copied link or a favourite)',
};

const sourceCard = card('How visitors arrived', { subtitle: 'by each visitor’s first view of this page' });
const sources = staticTable({
  empty: 'No one viewed this page in this period',
  columns: [
    { label: 'Arrived via', value: (r) => r.source, title: (r) => SOURCE_HELP[r.source] || (r.source === 'Direct' ? 'No referrer: typed, bookmarked, or opened from an app' : 'The page the link was on'), cls: 'nowrap' },
    { label: 'Visitors', value: (r) => fmt(r.visitors), cls: 'dl-num' },
    { label: 'Views', value: (r) => fmt(r.views), cls: 'dl-num' },
  ],
});
sourceCard.body.append(sources.node);

// From the page script (traffic.<domain>/t/s.js), on sites that load it: one row per page view.
const seconds = (n) => (n === null || n === undefined || n === '' ? '' : n < 60 ? `${n} s` : `${Math.floor(n / 60)} min ${n % 60} s`);
const percent = (part, whole) => (whole > 0 ? `${Math.round((part * 100) / whole)}%` : '');
const readingCard = card('Reading', { subtitle: 'from the page script: time the page was on screen and how far it was scrolled' });
const readingKpis = el('div');
const bucketTable = (label) => staticTable({
  empty: 'No reports',
  columns: [
    { label, value: (r) => r.bucket.slice(2), cls: 'nowrap' },
    { label: 'Views', value: (r) => fmt(r.views), cls: 'dl-num' },
    { label: 'Share', value: (r) => r.share, cls: 'dl-num dl-muted' },
  ],
});
const timeBuckets = bucketTable('Time on page');
const scrollBuckets = bucketTable('Scrolled to');
readingCard.body.append(readingKpis, el('div', { class: 'grid grid-pair' }, [timeBuckets.node, scrollBuckets.node]));

const readsCard = card('Page views read', { subtitle: 'latest 100 page views reported by the page script' });
const reads = staticTable({
  empty: 'No reports in this period (the site may not load the page script)',
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: 'Time', value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: 'Visitor ID', value: (r) => (r.visitor.startsWith('ip:') ? 'No cookie' : r.visitor), href: (r) => (r.visitor.startsWith('ip:') ? null : visitorLink(r.visitor)), cls: 'nowrap' },
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Country', value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: 'On screen', value: (r) => seconds(Number(r.seconds)), cls: 'dl-num nowrap' },
    { label: 'Scrolled', value: (r) => `${r.scroll}%`, cls: 'dl-num' },
    { label: 'Screen', value: (r) => screenText(r.screen), title: () => 'Screen width × height in CSS pixels, and pixel ratio', cls: 'nowrap dl-muted' },
    { label: 'Load', value: (r) => (r.load_ms ? `${(Number(r.load_ms) / 1000).toFixed(1)} s` : ''), title: () => 'Time until the page finished loading', cls: 'dl-num dl-muted' },
    { label: 'Errors', value: (r) => (Number(r.errors) ? r.errors : ''), title: () => 'Script errors on the page', cls: 'dl-num' },
    ...uaColumns('ua'),
  ],
});
readsCard.body.append(reads.node);

// 390x844x300 -> 390×844 @3x
function screenText(value) {
  const m = /^(\d+)x(\d+)x(\d+)$/.exec(value || '');
  return m ? `${m[1]}×${m[2]} @${Number(m[3]) / 100}x` : '';
}

const visitorCard = card('Visitors', { subtitle: 'who viewed this page, by dl_vid cookie (or IP without one)' });
const visitors = pagedTable({
  list: 'page_visitors',
  params: scope,
  pageSize: 20,
  placeholder: 'Search visitor ID, IP, country, city, user agent…',
  empty: 'No one viewed this page in this period',
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: 'Visitor ID', value: (r) => r.visitor_id || 'No cookie', href: (r) => (r.visitor_id ? visitorLink(r.visitor_id) : null), title: (r) => (r.visitor_id ? null : 'Counted by IP address: the browser never sent the dl_vid cookie back'), cls: 'nowrap' },
    { label: 'Last IP', value: (r) => r.last_ip, href: (r) => ipLink(r.last_ip), cls: 'nowrap' },
    { label: 'IPs', value: (r) => fmt(r.ips), cls: 'dl-num' },
    { label: 'Country', value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: 'City', value: (r) => r.city || '', cls: 'nowrap' },
    { label: 'Views', value: (r) => fmt(r.views), cls: 'dl-num' },
    { label: 'Arrived via', value: (r) => r.source || '', title: (r) => SOURCE_HELP[r.source] || null, cls: 'nowrap' },
    { label: 'Last viewed', value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: 'First viewed', value: (r) => formatTime(r.first_seen), cls: 'nowrap dl-muted' },
    ...uaColumns('last_ua'),
  ],
});
visitorCard.head.append(visitors.search);
visitorCard.body.append(visitors.node);

const ipCard = card('IP addresses', { subtitle: 'click an IP to see everything it did' });
const ips = pagedTable({
  list: 'page_ips',
  params: scope,
  pageSize: 20,
  placeholder: 'Search IP, country, city, user agent…',
  empty: 'No IP addresses viewed this page in this period',
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Country', value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: 'City', value: (r) => r.city || '', cls: 'nowrap' },
    { label: 'Views', value: (r) => fmt(r.views), cls: 'dl-num' },
    { label: 'Visitors', value: (r) => fmt(r.visitors), cls: 'dl-num' },
    { label: 'Last viewed', value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: 'First viewed', value: (r) => formatTime(r.first_seen), cls: 'nowrap dl-muted' },
    ...uaColumns('last_ua'),
  ],
});
ipCard.head.append(ips.search);
ipCard.body.append(ips.node);

const logCard = card('Requests', { subtitle: 'every request for this path, newest first' });
const log = pagedTable({
  list: 'requests',
  params: scope,
  pageSize: 20,
  placeholder: 'Search IP, city, status, user agent…',
  empty: 'No requests',
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: 'Time', value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Country', value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: 'City', value: (r) => r.city || '', cls: 'nowrap' },
    { label: 'Visitor ID', value: (r) => r.visitor_id || '', href: (r) => visitorLink(r.visitor_id), cls: 'nowrap dl-muted' },
    { label: 'Method', value: (r) => r.method },
    { label: 'Status', value: (r) => r.status, cls: 'dl-num' },
    { label: 'Referrer', value: (r) => r.referrer, cls: 'wrap dl-muted' },
    ...uaColumns('ua'),
  ],
});
logCard.head.append(log.search);
logCard.body.append(log.node);

page.append(
  el('p', { class: 'crumbs' }, [home, ' › ', siteCrumb, ' › Page']),
  el('div', { class: 'page-head' }, [el('h2', {}, [path, openLink]), el('div', { class: 'page-tools' }, [botToggle(load), periodBar(load)])]),
  periodNote,
  note.node,
  kpiBox,
  overTime.node,
  sourceCard.node,
  readingCard.node,
  readsCard.node,
  visitorCard.node,
  ipCard.node,
  logCard.node,
);

const pagePart = (name) => part('/api/page', name, scope());

const loadKpis = widget(kpiBox, () => pagePart('summary'), ({ filters: f, rows }) => {
  const s = rows[0] || {};
  periodNote.textContent = `Showing ${periodText(f)}. ${botsNote()}`;
  kpiBox.replaceChildren(kpis([
    ['Views', fmt(s.views), 'Loads of this page'],
    ['Visitors', fmt(s.visitors), 'Distinct visitors: the dl_vid cookie, or the IP when there is no cookie'],
    ['IP addresses', fmt(s.ips), 'Distinct IPs this page was viewed from'],
    ['Countries', fmt(s.countries)],
  ]));
});

const loadSources = widget(sourceCard.node, () => pagePart('sources'), ({ rows }) => sources.set(rows));

const loadReading = widget(readingKpis, () => pagePart('reading'), ({ rows }) => {
  const r = rows[0] || {};
  const views = Number(r.views || 0);
  readingKpis.replaceChildren(kpis([
    ['Views reported', fmt(r.views), 'Page views the page script reported (bots left out unless shown)'],
    ['Median time', views ? seconds(Number(r.median_seconds)) : '–', 'Half of the views had the page on screen for less than this'],
    ['Average time', views ? seconds(Number(r.average_seconds)) : '–', 'Time the page was on screen, averaged over views'],
    ['Read to the end', views ? percent(Number(r.read_to_end), views) : '–', 'Views scrolled to at least 90% of the page'],
    ['Median scroll', views ? `${r.median_scroll}%` : '–', 'How far down half of the views reached'],
    ['Median load', r.median_load_ms ? `${(Number(r.median_load_ms) / 1000).toFixed(1)} s` : '–', 'Time until the page finished loading'],
  ]));
});

const loadBuckets = widget(readingCard.body, () => pagePart('reading_buckets'), ({ rows }) => {
  const of = (kind) => {
    const list = rows.filter((r) => r.kind === kind);
    const total = list.reduce((sum, r) => sum + Number(r.views), 0);
    return list.map((r) => ({ ...r, share: percent(Number(r.views), total) }));
  };
  timeBuckets.set(of('time'));
  scrollBuckets.set(of('scroll'));
});

const loadReads = widget(readsCard.node, () => pagePart('reading_views'), ({ rows }) => reads.set(rows));

const loadChart = widget(overTime.node, () => pagePart('timeseries'), ({ filters: f, rows }) => {
  const keys = buckets(f);
  overTime.body.replaceChildren(chart(keys, {
    unit: f.unit,
    bars: series(keys, rows, 'views'),
    line: series(keys, rows, 'visitors'),
    barLabel: 'Views',
    lineLabel: 'Visitors',
  }));
});

// Every widget loads on its own and shows its data as soon as it arrives.
function load() {
  home.setAttribute('href', pageLink('/'));
  siteCrumb.setAttribute('href', siteLink(site));
  setStatus('');
  note.update();
  loadKpis();
  loadChart();
  loadSources();
  loadReading();
  loadBuckets();
  loadReads();
  for (const table of [visitors, ips, log]) table.load();
}

start(async () => {
  if (!Object.hasOwn(state.siteHosts, site) || !path.startsWith('/')) {
    location.replace(pageLink('/'));
    return;
  }
  siteCrumb.textContent = siteName(site);
  const live = siteUrl(site, path);
  if (live) openLink.setAttribute('href', live);
  else openLink.remove();
  document.title = `${path} · ${state.siteHosts[site]} · Traffic`;
  load();
});
