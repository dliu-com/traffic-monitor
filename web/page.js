import {
  $, botCheck, botToggle, botsNote, browserLabel, buckets, card, chart, countryName, countryNote, countryShort, el, filters, fmt, formatTime, ipLink, isBot, kpis,
  pageLink, pagedTable, part, periodBar, periodText, series, setStatus, siteLink, siteName, siteUrl, start, state, widget,
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

const visitorCard = card('Visitors', { subtitle: 'who viewed this page, by dl_vid cookie (or IP without one)' });
const visitors = pagedTable({
  list: 'page_visitors',
  params: scope,
  pageSize: 20,
  placeholder: 'Search visitor ID, IP, country, city, user agent…',
  empty: 'No one viewed this page in this period',
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: 'Visitor ID', value: (r) => r.visitor_id || 'No cookie', title: (r) => (r.visitor_id ? null : 'Counted by IP address: the browser never sent the dl_vid cookie back'), cls: 'nowrap' },
    { label: 'Last IP', value: (r) => r.last_ip, href: (r) => ipLink(r.last_ip), cls: 'nowrap' },
    { label: 'IPs', value: (r) => fmt(r.ips), cls: 'num' },
    { label: 'Country', value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: 'City', value: (r) => r.city || '', cls: 'nowrap' },
    { label: 'Views', value: (r) => fmt(r.views), cls: 'num' },
    { label: 'Last viewed', value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: 'First viewed', value: (r) => formatTime(r.first_seen), cls: 'nowrap muted' },
    { label: 'Browser', value: (r) => browserLabel(r.last_ua, r.asn), title: (r) => r.last_ua, cls: 'muted' },
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
    { label: 'Views', value: (r) => fmt(r.views), cls: 'num' },
    { label: 'Visitors', value: (r) => fmt(r.visitors), cls: 'num' },
    { label: 'Last viewed', value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: 'First viewed', value: (r) => formatTime(r.first_seen), cls: 'nowrap muted' },
    { label: 'Browser', value: (r) => browserLabel(r.last_ua, r.asn), title: (r) => r.last_ua, cls: 'muted' },
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
    { label: 'Visitor ID', value: (r) => r.visitor_id || '', cls: 'nowrap muted' },
    { label: 'Method', value: (r) => r.method },
    { label: 'Status', value: (r) => r.status, cls: 'num' },
    { label: 'Referrer', value: (r) => r.referrer, cls: 'wrap muted' },
    { label: 'Browser', value: (r) => browserLabel(r.ua, r.asn), title: (r) => r.ua, cls: 'muted' },
  ],
});
logCard.head.append(log.search);
logCard.body.append(log.node);

page.append(
  el('p', { class: 'crumbs' }, [home, ' › ', siteCrumb, ' › Page']),
  el('div', { class: 'page-head' }, [el('h2', {}, [path, openLink]), el('div', { class: 'page-tools' }, [botCheck(load), botToggle(load), periodBar(load)])]),
  periodNote,
  note.node,
  kpiBox,
  overTime.node,
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
