import {
  $, IP_PATTERN, ago, card, countryLabel, countryName, countryShort, describeUA, el, facts, fmt, formatTime, ipLink, isBot, kpis,
  pageLink, pagedTable, part, period, periodBar, periodText, setStatus, siteLink, siteName, start, staticTable, widget,
} from './dash.js';

const page = $('page');
const ip = new URLSearchParams(location.search).get('ip') || '';

const home = el('a', { text: 'All sites' });
const title = el('h2', {}, [ip]);
const periodNote = el('p', { class: 'period-note' });
const kpiBox = el('div', { class: 'kpi-box' });
const aboutCard = card('About this IP');
// The summary fills the title, KPIs and "About this IP"; one spinner covers the KPIs and the About card.
const summaryBox = el('div', {}, [kpiBox, aboutCard.node]);

const sitesCard = card('Sites visited');
const sites = staticTable({
  empty: 'No requests from this IP in this period',
  columns: [
    { label: 'Site', value: (r) => siteName(r.site), href: (r) => siteLink(r.site) },
    { label: 'Page views', value: (r) => fmt(r.pageviews), cls: 'num' },
    { label: 'Requests', value: (r) => fmt(r.requests), cls: 'num' },
    { label: 'First seen', value: (r) => formatTime(r.first_seen), cls: 'nowrap muted' },
    { label: 'Last seen', value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
  ],
});
sitesCard.body.append(sites.node);

const relatedCard = card('Same visitor on other IPs', { subtitle: 'IPs used by the same dl_vid visitor ID' });
const scope = () => ({ site: 'all', ip, ...period() });
const related = pagedTable({
  list: 'related',
  params: scope,
  pageSize: 10,
  placeholder: 'Search IP, site, user agent…',
  empty: 'None — this cookie was only seen on this IP',
  columns: [
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Country', value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: 'Last seen', value: (r) => ago(r.last_seen), title: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: 'Sites', value: (r) => (r.sites || '').split(',').filter(Boolean).map(siteName).join(', ') },
    { label: 'Page views', value: (r) => fmt(r.pageviews), cls: 'num' },
    { label: 'Browser', value: (r) => describeUA(r.last_ua), title: (r) => r.last_ua, cls: 'muted' },
  ],
});
relatedCard.head.append(related.search);
relatedCard.body.append(related.node);

const cookieCard = card('Visitor IDs', { subtitle: 'dl_vid IDs used from this IP' });
const cookies = pagedTable({
  list: 'cookies',
  params: scope,
  pageSize: 10,
  placeholder: 'Search cookie ID, site…',
  empty: 'No dl_vid visitor ID was seen from this IP',
  columns: [
    { label: 'Visitor ID', value: (r) => r.visitor_id, cls: 'nowrap' },
    { label: 'Last seen', value: (r) => ago(r.last_seen), title: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: 'Sites', value: (r) => (r.sites || '').split(',').filter(Boolean).map(siteName).join(', ') },
    { label: 'Page views', value: (r) => fmt(r.pageviews), cls: 'num' },
    { label: 'Requests', value: (r) => fmt(r.requests), cls: 'num' },
  ],
});
cookieCard.head.append(cookies.search);
cookieCard.body.append(cookies.node);

const logCard = card('Requests', { subtitle: 'newest first' });
const log = pagedTable({
  list: 'requests',
  params: scope,
  pageSize: 50,
  placeholder: 'Search path, site, status…',
  empty: 'No requests',
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: 'Time', value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: 'Site', value: (r) => siteName(r.site), cls: 'nowrap' },
    { label: 'Method', value: (r) => r.method },
    { label: 'Path', value: (r) => r.path, cls: 'wrap' },
    { label: 'Status', value: (r) => r.status, cls: 'num' },
    { label: 'Referrer', value: (r) => r.referrer, cls: 'wrap muted' },
    { label: 'Browser', value: (r) => describeUA(r.ua), title: (r) => r.ua, cls: 'muted' },
  ],
});
logCard.head.append(log.search);
logCard.body.append(log.node);

page.append(
  el('p', { class: 'crumbs' }, [home, ' › IP address']),
  el('div', { class: 'page-head' }, [title, periodBar(load)]),
  periodNote,
  summaryBox,
  el('div', { class: 'grid grid-pair' }, [sitesCard.node, cookieCard.node]),
  relatedCard.node,
  logCard.node,
);

const ipPart = (name) => part('/api/ip', name, { ip, ...period() });

const loadSummary = widget(summaryBox, () => ipPart('summary'), ({ filters, rows }) => {
  const s = rows[0] || {};
  const seen = Number(s.requests) > 0;
  periodNote.textContent = `Showing ${periodText(filters)} across all sites.`;
  title.replaceChildren(ip, seen ? el('span', { class: `tag${isBot(s) ? ' bot' : ''}`, text: isBot(s) ? 'Bot' : 'Person' }) : null);
  kpiBox.replaceChildren(kpis([
    ['Page views', fmt(s.pageviews), 'HTML page loads'],
    ['Requests', fmt(s.requests), 'Everything, including assets'],
    ['Sites', fmt(s.sites)],
    ['Days active', fmt(s.days), 'UTC days with at least one request'],
  ]));
  const lookup = el('a', { href: `https://ipinfo.io/${encodeURIComponent(ip)}`, target: '_blank', rel: 'noopener noreferrer', text: 'Look up city and network name on ipinfo.io ↗' });
  const countries = Number(s.countries) || 0;
  aboutCard.body.replaceChildren(
    facts([
      ['Country', s.country ? `${countryLabel(s.country)}${countries > 1 ? ` (${countries} countries in this period)` : ''}` : (seen ? 'Not recorded' : ''),
        s.country ? null : 'Country is recorded by CloudFront for requests logged after country logging started'],
      ['Network', s.asn ? `AS${s.asn}` : (seen ? 'Not recorded' : ''), 'The autonomous system (ISP or hosting provider) the IP belongs to'],
      ['First seen', seen ? `${formatTime(s.first_seen)} (${ago(s.first_seen)})` : ''],
      ['Last seen', seen ? `${formatTime(s.last_seen)} (${ago(s.last_seen)})` : ''],
      ['Latest browser', describeUA(s.last_ua), s.last_ua],
      ['Different browsers', seen ? fmt(s.user_agents) : ''],
      ['Visitor IDs (dl_vid)', seen ? fmt(s.cookies) : ''],
      ['Errors', seen ? fmt(s.errors) : ''],
    ]),
    el('p', {}, [lookup]),
  );
  setStatus(seen ? '' : 'This IP made no requests in this period. Try a longer period.');
});

const loadSites = widget(sitesCard.node, () => ipPart('sites'), ({ rows }) => sites.set(rows));

// Every widget loads on its own and shows its data as soon as it arrives.
function load() {
  home.setAttribute('href', pageLink('/'));
  setStatus('');
  loadSummary();
  loadSites();
  for (const table of [cookies, related, log]) table.load();
}

start(async () => {
  if (!IP_PATTERN.test(ip)) {
    location.replace(pageLink('/'));
    return;
  }
  document.title = `${ip} · Traffic`;
  load();
});
