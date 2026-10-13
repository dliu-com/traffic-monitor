import {
  $, botToggle, botsNote, browserLabel, buckets, card, chart, countriesTable, countryName, countryNote, countrySelect, countryShort, el, filters, fmt,
  formatTime, ipLink, isBot, kpis, pageDetailsLink, pageLink, pagedTable, part, periodBar, periodText, series, setStatus, siteName, start, state, updatedNote, widget,
} from './dash.js';

const page = $('page');
const site = new URLSearchParams(location.search).get('site') || '';

function checkbox(label, checked) {
  const input = el('input', { type: 'checkbox', checked });
  return { input, node: el('label', {}, [input, ` ${label}`]) };
}

const switcher = el('select', { 'aria-label': 'Choose a site' });
const crumb = el('span');
const home = el('a', { text: 'All sites' });
const openLink = el('a', { target: '_blank', rel: 'noopener noreferrer', text: 'Open site ↗' });
const periodNote = el('p', { class: 'period-note' });
const kpiBox = el('div', { class: 'kpi-box' });
const overTime = card('Visits over time');

const pagesCard = card('Top pages');
const scope = () => ({ site, ...filters() });
const countryCard = card('Countries', { subtitle: 'click one to filter' });
const countries = countriesTable(scope);
countryCard.head.append(countries.search);
countryCard.body.append(countries.node);
const picker = countrySelect(scope, load);
const note = countryNote(load);
const pages = pagedTable({
  list: 'pages',
  params: scope,
  pageSize: 10,
  placeholder: 'Search pages or paste a URL…',
  empty: 'No page views',
  searchUrls: true,
  columns: [
    { label: 'Page', value: (r) => r.path, href: (r) => pageDetailsLink(site, r.path), external: true, title: () => 'Visitors and IP addresses of this page', cls: 'wrap' },
    { label: 'Views', value: (r) => fmt(r.views), cls: 'num' },
    { label: 'Visitors', value: (r) => fmt(r.visitors), cls: 'num' },
  ],
});
pagesCard.head.append(pages.search);
pagesCard.body.append(pages.node);

const refCard = card('External referrers');
const referrers = pagedTable({
  list: 'referrers',
  params: scope,
  pageSize: 10,
  placeholder: 'Search referrers…',
  empty: 'No external referrers',
  columns: [
    { label: 'Referrer', value: (r) => r.referrer || '(unknown)', cls: 'wrap' },
    { label: 'Views', value: (r) => fmt(r.views), cls: 'num' },
    { label: 'Visitors', value: (r) => fmt(r.visitors), cls: 'num' },
  ],
});
refCard.head.append(referrers.search);
refCard.body.append(referrers.node);

const ipCard = card('IP addresses', { subtitle: 'click an IP to see everything it did', className: 'private-only' });
const ips = pagedTable({
  list: 'ips',
  params: scope,
  pageSize: 20,
  placeholder: 'Search IP, country, city, user agent…',
  empty: 'No visitors in this period',
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Country', value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: 'City', value: (r) => r.city || '', cls: 'nowrap' },
    { label: 'Last seen', value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: 'Page views', value: (r) => fmt(r.pageviews), cls: 'num' },
    { label: 'Requests', value: (r) => fmt(r.requests), cls: 'num' },
    { label: 'Browser', value: (r) => browserLabel(r.last_ua, r.asn), title: (r) => r.last_ua, cls: 'muted' },
    { label: 'First seen', value: (r) => formatTime(r.first_seen), cls: 'nowrap muted' },
  ],
});
ipCard.head.append(ips.search);
ipCard.body.append(ips.node);

const pagesOnly = checkbox('Pages only', false);
const logCard = card('Request log', { subtitle: 'newest first', className: 'private-only' });
const log = pagedTable({
  list: 'requests',
  params: () => ({ ...scope(), ...(pagesOnly.input.checked ? { pages: 'only' } : {}) }),
  pageSize: 20,
  placeholder: 'Search path, URL, IP, city, status, user agent…',
  empty: 'No requests',
  searchUrls: true,
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: 'Time', value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Country', value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: 'City', value: (r) => r.city || '', cls: 'nowrap' },
    { label: 'Method', value: (r) => r.method },
    { label: 'Path', value: (r) => r.path, cls: 'wrap' },
    { label: 'Status', value: (r) => r.status, cls: 'num' },
    { label: 'Referrer', value: (r) => r.referrer, cls: 'wrap muted' },
    { label: 'Browser', value: (r) => browserLabel(r.ua, r.asn), title: (r) => r.ua, cls: 'muted' },
  ],
});
logCard.head.append(pagesOnly.node, log.search);
logCard.body.append(log.node);

page.append(
  el('p', { class: 'crumbs' }, [home, ' › ', crumb]),
  el('div', { class: 'page-head' }, [el('h2', {}, [switcher, openLink]), el('div', { class: 'page-tools' }, [botToggle(load), picker.node, periodBar(load)])]),
  periodNote,
  note.node,
  kpiBox,
  el('div', { class: 'grid grid-chart' }, [overTime.node, countryCard.node]),
  el('div', { class: 'grid grid-pair private-only' }, [pagesCard.node, refCard.node]),
  ipCard.node,
  logCard.node,
);

const reload = (table) => () => table.load();
pagesOnly.input.addEventListener('change', reload(log));

const overview = (name) => part('/api/overview', name, scope());

const loadKpis = widget(kpiBox, () => overview('summary'), ({ filters, rows }) => {
  const total = rows[0] || {};
  periodNote.textContent = `Showing ${periodText(filters)}. ${botsNote()}${updatedNote(filters)}`;
  kpiBox.replaceChildren(kpis([
    ['Visitors', fmt(total.visitors), 'Distinct visitors: the dl_vid cookie, or the IP when there is no cookie'],
    ['Page views', fmt(total.pageviews), 'HTML page loads'],
    ['IP addresses', fmt(total.ips), 'Distinct IP addresses'],
    ['Requests', fmt(total.requests), 'Everything, including assets'],
    ['Errors', fmt(total.errors), 'Responses with status 400 or higher'],
  ]));
});

const loadChart = widget(overTime.node, () => overview('timeseries'), ({ filters, rows }) => {
  const keys = buckets(filters);
  overTime.body.replaceChildren(chart(keys, {
    unit: filters.unit,
    bars: series(keys, rows, 'pageviews'),
    line: series(keys, rows, 'visitors'),
    barLabel: 'Page views',
    lineLabel: 'Visitors',
  }));
});

// Every widget loads on its own and shows its data as soon as it arrives.
function load() {
  home.setAttribute('href', pageLink('/'));
  setStatus('');
  note.update();
  picker.load();
  loadKpis();
  loadChart();
  countries.load();
  if (!state.public) for (const table of [pages, referrers, ips, log]) table.load();
}

start(async () => {
  if (!Object.hasOwn(state.siteHosts, site)) {
    location.replace(pageLink('/'));
    return;
  }
  for (const [key, host] of Object.entries(state.siteHosts)) switcher.append(el('option', { value: key, text: host, selected: key === site }));
  switcher.addEventListener('change', () => location.assign(pageLink('/site', { site: switcher.value })));
  crumb.textContent = siteName(site);
  openLink.setAttribute('href', `https://${state.siteHosts[site]}/`);
  document.title = `${state.siteHosts[site]} · Traffic`;
  load();
}, { publicView: true });
