import {
  $, IP_PATTERN, api, ago, card, dataTable, describeUA, el, facts, fmt, formatTime, handleError, ipLink, isBot, kpis,
  pageLink, period, periodBar, periodText, setStatus, siteLink, siteName, start,
} from './dash.js';

const page = $('page');
const ip = new URLSearchParams(location.search).get('ip') || '';

const home = el('a', { text: 'All sites' });
const title = el('h2', {}, [ip]);
const periodNote = el('p', { class: 'period-note' });
const kpiBox = el('div');
const aboutCard = card('About this IP');

const sitesCard = card('Sites visited');
const sites = dataTable({
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

const relatedCard = card('Same visitor on other IPs', { subtitle: 'IPs that sent the same dl_vid cookie' });
const related = dataTable({
  limit: 10,
  placeholder: 'Find IP…',
  empty: 'None — this cookie was only seen on this IP',
  columns: [
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Last seen', value: (r) => ago(r.last_seen), title: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: 'Sites', value: (r) => (r.sites || '').split(',').filter(Boolean).map(siteName).join(', ') },
    { label: 'Page views', value: (r) => fmt(r.pageviews), cls: 'num' },
    { label: 'Browser', value: (r) => describeUA(r.last_ua), title: (r) => r.last_ua, cls: 'muted' },
  ],
});
relatedCard.head.append(related.search);
relatedCard.body.append(related.node);

const logCard = card('Requests', { subtitle: 'newest first' });
const log = dataTable({
  limit: 50,
  placeholder: 'Find path, site, status…',
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
  kpiBox,
  aboutCard.node,
  el('div', { class: 'grid grid-pair' }, [sitesCard.node, relatedCard.node]),
  logCard.node,
);

async function load() {
  home.setAttribute('href', pageLink('/'));
  setStatus('Loading…');
  try {
    const data = await api(`/api/ip?${new URLSearchParams({ ip, ...period() })}`);
    const s = data.summary[0] || {};
    const seen = Number(s.requests) > 0;
    periodNote.textContent = `Showing ${periodText(data.filters)} (UTC days) across all sites.`;
    title.replaceChildren(ip, seen ? el('span', { class: `tag${isBot(s) ? ' bot' : ''}`, text: isBot(s) ? 'Bot' : 'Person' }) : null);
    kpiBox.replaceChildren(kpis([
      ['Page views', fmt(s.pageviews), 'HTML page loads'],
      ['Requests', fmt(s.requests), 'Everything, including assets'],
      ['Sites', fmt(s.sites)],
      ['Days active', fmt(s.days), 'UTC days with at least one request'],
    ]));
    const cookies = (s.cookies || '').split(',').filter(Boolean);
    const lookup = el('a', { href: `https://ipinfo.io/${encodeURIComponent(ip)}`, target: '_blank', rel: 'noopener noreferrer', text: 'Look up location and network on ipinfo.io ↗' });
    aboutCard.body.replaceChildren(
      facts([
        ['First seen', seen ? `${formatTime(s.first_seen)} (${ago(s.first_seen)})` : ''],
        ['Last seen', seen ? `${formatTime(s.last_seen)} (${ago(s.last_seen)})` : ''],
        ['Latest browser', describeUA(s.last_ua), s.last_ua],
        ['Different browsers', seen ? fmt(s.user_agents) : ''],
        ['Visitor cookies (dl_vid)', cookies.length ? `${cookies.slice(0, 5).join(', ')}${cookies.length > 5 ? ` +${cookies.length - 5} more` : ''}` : 'none', cookies.join(', ')],
        ['Errors', seen ? fmt(s.errors) : ''],
      ]),
      el('p', {}, [lookup]),
    );
    sites.set(data.sites);
    related.set(data.related);
    log.set(data.requests);
    setStatus(seen ? '' : 'This IP made no requests in this period. Try a longer period.');
  } catch (error) {
    handleError(error);
  }
}

start(async () => {
  if (!IP_PATTERN.test(ip)) {
    location.replace(pageLink('/'));
    return;
  }
  document.title = `${ip} · Traffic`;
  await load();
});
