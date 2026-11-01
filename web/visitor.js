import {
  $, botReasonText, card, countryLabel, countryName, countryShort, describeBrowser, describeDevice, el, facts, fmt,
  formatTime, hostingName, ipLink, isBot, kpis, pageDetailsLink, pagedTable, pageLink, part, period, periodBar,
  periodText, setStatus, siteLink, siteName, start, staticTable, uaColumns, VISITOR_PATTERN, widget,
} from './dash.js';

// Everything one dl_vid visitor ID did, across every site and IP address.
const page = $('page');
const visitor = new URLSearchParams(location.search).get('visitor') || '';

const home = el('a', { text: 'All sites' });
const title = el('h2', {}, [visitor]);
const periodNote = el('p', { class: 'period-note' });
const kpiBox = el('div', { class: 'kpi-box' });
const aboutCard = card('About this visitor');
const summaryBox = el('div', {}, [kpiBox, aboutCard.node]);

const sitesCard = card('Sites visited');
const sites = staticTable({
  empty: 'No requests from this visitor in this period',
  columns: [
    { label: 'Site', value: (r) => siteName(r.site), href: (r) => siteLink(r.site) },
    { label: 'Page views', value: (r) => fmt(r.pageviews), cls: 'num' },
    { label: 'Requests', value: (r) => fmt(r.requests), cls: 'num' },
    { label: 'First seen', value: (r) => formatTime(r.first_seen), cls: 'nowrap muted' },
    { label: 'Last seen', value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
  ],
});
sitesCard.body.append(sites.node);

const scope = () => ({ site: 'all', visitor, ...period() });

const ipsCard = card('IP addresses', { subtitle: 'IPs this visitor ID was seen on' });
const ips = pagedTable({
  list: 'visitor_ips',
  params: scope,
  pageSize: 10,
  placeholder: 'Search IP, site, city, user agent…',
  empty: 'No IP addresses',
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Country', value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: 'City', value: (r) => r.city || '', cls: 'nowrap' },
    { label: 'Last seen', value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: 'Sites', value: (r) => (r.sites || '').split(',').filter(Boolean).map(siteName).join(', ') },
    { label: 'Page views', value: (r) => fmt(r.pageviews), cls: 'num' },
    ...uaColumns('last_ua'),
  ],
});
ipsCard.head.append(ips.search);
ipsCard.body.append(ips.node);

const pagesCard = card('Pages visited', { subtitle: 'most recent first' });
const pages = pagedTable({
  list: 'visitor_pages',
  params: scope,
  pageSize: 20,
  placeholder: 'Search page, site…',
  empty: 'No page views',
  columns: [
    { label: 'Site', value: (r) => siteName(r.site), cls: 'nowrap' },
    { label: 'Page', value: (r) => r.path, href: (r) => pageDetailsLink(r.site, r.path), cls: 'wrap' },
    { label: 'Views', value: (r) => fmt(r.views), cls: 'num' },
    { label: 'First seen', value: (r) => formatTime(r.first_seen), cls: 'nowrap muted' },
    { label: 'Last seen', value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
  ],
});
pagesCard.head.append(pages.search);
pagesCard.body.append(pages.node);

const logCard = card('Requests', { subtitle: 'newest first' });
const log = pagedTable({
  list: 'requests',
  params: scope,
  pageSize: 50,
  placeholder: 'Search path, site, IP, status…',
  empty: 'No requests',
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: 'Time', value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: 'Site', value: (r) => siteName(r.site), cls: 'nowrap' },
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Method', value: (r) => r.method },
    { label: 'Path', value: (r) => r.path, cls: 'wrap' },
    { label: 'Status', value: (r) => r.status, cls: 'num' },
    { label: 'Referrer', value: (r) => r.referrer, cls: 'wrap muted' },
    ...uaColumns('ua', false),
  ],
});
logCard.head.append(log.search);
logCard.body.append(log.node);

page.append(
  el('p', { class: 'crumbs' }, [home, ' › Visitor']),
  el('div', { class: 'page-head' }, [title, periodBar(load)]),
  periodNote,
  summaryBox,
  el('div', { class: 'grid grid-pair' }, [sitesCard.node, ipsCard.node]),
  pagesCard.node,
  logCard.node,
);

const loadSummary = widget(summaryBox, () => part('/api/visitor', 'summary', { visitor, ...period() }), ({ filters, rows }) => {
  const s = rows[0] || {};
  const seen = Number(s.requests) > 0;
  periodNote.textContent = `Showing ${periodText(filters)} across all sites and IP addresses, bots included.`;
  title.replaceChildren(visitor, seen ? el('span', { class: `tag${isBot(s) ? ' bot' : ''}`, text: isBot(s) ? 'Bot' : 'Person' }) : null);
  kpiBox.replaceChildren(kpis([
    ['Page views', fmt(s.pageviews), 'HTML page loads'],
    ['Requests', fmt(s.requests), 'Everything, including assets'],
    ['Sites', fmt(s.sites)],
    ['IP addresses', fmt(s.ips)],
    ['Days active', fmt(s.days), 'UTC days with at least one request'],
  ]));
  const countries = Number(s.countries) || 0;
  aboutCard.body.replaceChildren(facts([
    ['Latest IP', s.last_ip || ''],
    ['Country', s.country ? `${countryLabel(s.country)}${countries > 1 ? ` (${countries} countries in this period)` : ''}` : (seen ? 'Not recorded' : '')],
    ['City', s.city || (seen ? 'Not recorded' : ''), s.city ? 'Latest city CloudFront placed this visitor in (approximate); “(DB-IP)” means it comes from DB-IP’s database' : null],
    ['Network', s.asn ? `AS${s.asn}${hostingName(s.asn) ? ` · ${hostingName(s.asn)} (hosting network)` : ''}` : (seen ? 'Not recorded' : '')],
    ['Counted as a bot', seen ? (botReasonText(s.bot_reasons) || 'No') : '',
      'Crawler user agents count at once; the other reasons come from the bot check every 6 hours'],
    ['First seen', seen ? formatTime(s.first_seen) : ''],
    ['Last seen', seen ? formatTime(s.last_seen) : ''],
    ['Latest browser', describeBrowser(s.last_ua), s.last_ua],
      ['Latest device', describeDevice(s.last_ua), s.last_ua],
    ['Different browsers', seen ? fmt(s.user_agents) : ''],
    ['Errors', seen ? fmt(s.errors) : ''],
  ]));
  setStatus(seen ? '' : 'This visitor made no requests in this period. Try a longer period.');
});

const loadSites = widget(sitesCard.node, () => part('/api/visitor', 'sites', { visitor, ...period() }), ({ rows }) => sites.set(rows));

function load() {
  home.setAttribute('href', pageLink('/'));
  setStatus('');
  loadSummary();
  loadSites();
  for (const table of [ips, pages, log]) table.load();
}

start(async () => {
  if (!VISITOR_PATTERN.test(visitor)) {
    location.replace(pageLink('/'));
    return;
  }
  document.title = `${visitor} · Traffic`;
  load();
});
