import {
  $, api, ago, buckets, card, chart, dataTable, describeUA, el, fmt, formatTime, handleError, ipLink, isBot, kpis,
  pageLink, period, periodBar, periodText, series, setStatus, siteName, start, state,
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
const kpiBox = el('div');
const overTime = card('Visits over time');

const pagesCard = card('Top pages');
const pages = dataTable({
  limit: 10,
  placeholder: 'Find page…',
  empty: 'No page views',
  columns: [
    { label: 'Page', value: (r) => r.path, cls: 'wrap' },
    { label: 'Views', value: (r) => fmt(r.views), cls: 'num' },
    { label: 'Visitors', value: (r) => fmt(r.visitors), cls: 'num' },
  ],
});
pagesCard.head.append(pages.search);
pagesCard.body.append(pages.node);

const refCard = card('External referrers');
const referrers = dataTable({
  limit: 10,
  placeholder: 'Find referrer…',
  empty: 'No external referrers',
  columns: [
    { label: 'Referrer', value: (r) => r.referrer || '(unknown)', cls: 'wrap' },
    { label: 'Views', value: (r) => fmt(r.views), cls: 'num' },
    { label: 'Visitors', value: (r) => fmt(r.visitors), cls: 'num' },
  ],
});
refCard.head.append(referrers.search);
refCard.body.append(referrers.node);

const ipBots = checkbox('Include bots', false);
const ipCard = card('IP addresses', { subtitle: 'click an IP to see everything it did' });
const ips = dataTable({
  limit: 20,
  placeholder: 'Find IP, browser…',
  empty: 'No visitors in this period',
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Last seen', value: (r) => ago(r.last_seen), title: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: 'Page views', value: (r) => fmt(r.pageviews), cls: 'num' },
    { label: 'Requests', value: (r) => fmt(r.requests), cls: 'num' },
    { label: 'Browser', value: (r) => describeUA(r.last_ua), title: (r) => r.last_ua, cls: 'muted' },
    { label: 'First seen', value: (r) => formatTime(r.first_seen), cls: 'nowrap muted' },
  ],
});
ipCard.head.append(ipBots.node, ips.search);
ipCard.body.append(ips.node);

const hideBots = checkbox('Hide bots', true);
const pagesOnly = checkbox('Pages only', false);
const logCard = card('Request log', { subtitle: 'newest first' });
const log = dataTable({
  limit: 20,
  placeholder: 'Find path, IP, status…',
  empty: 'No requests',
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: 'Time', value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Method', value: (r) => r.method },
    { label: 'Path', value: (r) => r.path, cls: 'wrap' },
    { label: 'Status', value: (r) => r.status, cls: 'num' },
    { label: 'Referrer', value: (r) => r.referrer, cls: 'wrap muted' },
    { label: 'Browser', value: (r) => describeUA(r.ua), title: (r) => r.ua, cls: 'muted' },
  ],
});
logCard.head.append(hideBots.node, pagesOnly.node, log.search);
logCard.body.append(log.node);

page.append(
  el('p', { class: 'crumbs' }, [home, ' › ', crumb]),
  el('div', { class: 'page-head' }, [el('h2', {}, [switcher, openLink]), periodBar(load)]),
  periodNote,
  kpiBox,
  overTime.node,
  el('div', { class: 'grid grid-pair' }, [pagesCard.node, refCard.node]),
  ipCard.node,
  logCard.node,
);

let ipRows = [];
const showIps = () => ips.set(ipBots.input.checked ? ipRows : ipRows.filter((r) => !isBot(r)));
ipBots.input.addEventListener('change', showIps);

async function loadLog() {
  try {
    const params = { site, ...period(), limit: '1000' };
    if (hideBots.input.checked) params.bots = 'hide';
    if (pagesOnly.input.checked) params.pages = 'only';
    const data = await api(`/api/requests?${new URLSearchParams(params)}`);
    log.set(data.requests);
  } catch (error) {
    handleError(error);
  }
}
hideBots.input.addEventListener('change', loadLog);
pagesOnly.input.addEventListener('change', loadLog);

async function load() {
  home.setAttribute('href', pageLink('/'));
  setStatus('Loading…');
  try {
    const data = await api(`/api/overview?${new URLSearchParams({ site, ...period() })}`);
    const { filters } = data;
    const total = data.summary[0] || {};
    periodNote.textContent = `Showing ${periodText(filters)} (UTC days). Bots and crawlers are left out of visitors and page views.`;
    kpiBox.replaceChildren(kpis([
      ['Visitors', fmt(total.visitors), 'Distinct people: the dl_vid cookie, or the IP when there is no cookie'],
      ['Page views', fmt(total.pageviews), 'HTML page loads by people'],
      ['IP addresses', fmt(total.human_ips), 'Distinct IPs used by people (not bots)'],
      ['Requests', fmt(total.requests), 'Everything, including assets and bots'],
      ['Errors', fmt(total.errors), 'Responses with status 400 or higher'],
    ]));
    const keys = buckets(filters);
    overTime.body.replaceChildren(chart(keys, {
      hourly: filters.hourly,
      bars: series(keys, data.timeseries, 'pageviews'),
      line: series(keys, data.timeseries, 'visitors'),
      barLabel: 'Page views',
      lineLabel: 'Visitors',
    }));
    pages.set(data.pages);
    referrers.set(data.referrers);
    ipRows = data.ips;
    showIps();
    await loadLog();
    setStatus('');
  } catch (error) {
    handleError(error);
  }
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
  await load();
});
