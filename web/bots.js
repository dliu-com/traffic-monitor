// The Bots page (signed in only): what the requests judged to be bots did. Bot records are kept for the
// last 3 days; the daily log merge then deletes them, so older periods only show what is left.
import {
  $, BOT_REASONS, botCheck, botReasonText, browserLabel, buckets, card, chart, countryName, countryShort, el, filters, fmt, formatTime,
  ipLink, kpis, pagedTable, part, periodBar, periodText, series, setStatus, siteName, staticTable, start, state, widget,
} from './dash.js';

state.defaultRange = '3d';
const page = $('page');
const periodNote = el('p', { class: 'period-note' });
const kpiBox = el('div', { class: 'kpi-box' });
const overTime = card('Bot requests over time');
const scope = () => ({ site: 'all', ...filters(), bots: 'only' });
const records = (name) => part('/api/bot-records', name, scope());
const reasonLabel = (reason) => (Object.hasOwn(BOT_REASONS, reason) ? BOT_REASONS[reason] : reason || '');

const reasonCard = card('Why they count as bots');
const reasons = staticTable({
  empty: 'No bots in this period',
  columns: [
    { label: 'Reason', value: (r) => reasonLabel(r.reason) },
    { label: 'Requests', value: (r) => fmt(r.requests), cls: 'num' },
    { label: 'IPs', value: (r) => fmt(r.ips), cls: 'num' },
  ],
});
reasonCard.body.append(reasons.node);

const siteCard = card('Sites');
const sites = staticTable({
  empty: 'No bots in this period',
  columns: [
    { label: 'Site', value: (r) => siteName(r.site) },
    { label: 'Requests', value: (r) => fmt(r.requests), cls: 'num' },
    { label: 'IPs', value: (r) => fmt(r.ips), cls: 'num' },
    { label: 'Last seen', value: (r) => formatTime(r.last_seen), cls: 'nowrap muted' },
  ],
});
siteCard.body.append(sites.node);

const ipCard = card('Bot IP addresses', { subtitle: 'click an IP to see everything it did' });
const ips = pagedTable({
  list: 'ips',
  params: scope,
  pageSize: 15,
  placeholder: 'Search IP, site, country, city, user agent…',
  empty: 'No bots in this period',
  columns: [
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Why', value: (r) => botReasonText(r.bot_reason) },
    { label: 'Country', value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: 'Last seen', value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: 'Sites', value: (r) => (r.sites || '').split(',').filter(Boolean).map(siteName).join(', ') },
    { label: 'Requests', value: (r) => fmt(r.requests), cls: 'num' },
    { label: 'Browser', value: (r) => browserLabel(r.last_ua, r.asn), title: (r) => r.last_ua, cls: 'muted' },
  ],
});
ipCard.head.append(ips.search);
ipCard.body.append(ips.node);

const agentCard = card('User agents');
const agents = pagedTable({
  list: 'agents',
  params: scope,
  pageSize: 10,
  placeholder: 'Search user agents or sites…',
  empty: 'No bots in this period',
  columns: [
    { label: 'User agent', value: (r) => (r.ua && r.ua !== '-' ? r.ua : '(none)'), cls: 'wrap' },
    { label: 'Requests', value: (r) => fmt(r.requests), cls: 'num' },
    { label: 'IPs', value: (r) => fmt(r.ips), cls: 'num' },
    { label: 'Sites', value: (r) => (r.sites || '').split(',').filter(Boolean).map(siteName).join(', ') },
    { label: 'Last seen', value: (r) => formatTime(r.last_seen), cls: 'nowrap muted' },
  ],
});
agentCard.head.append(agents.search);
agentCard.body.append(agents.node);

const logCard = card('Bot requests', { subtitle: 'newest first' });
const log = pagedTable({
  list: 'requests',
  params: scope,
  pageSize: 20,
  placeholder: 'Search site, IP, path, status, user agent…',
  empty: 'No bots in this period',
  columns: [
    { label: 'Time', value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: 'Site', value: (r) => siteName(r.site), cls: 'nowrap' },
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Why', value: (r) => reasonLabel(r.bot_reason) },
    { label: 'Request', value: (r) => `${r.method} ${r.path}`, cls: 'wrap' },
    { label: 'Status', value: (r) => r.status, cls: 'num' },
    { label: 'Browser', value: (r) => browserLabel(r.ua, r.asn), title: (r) => r.ua, cls: 'muted' },
  ],
});
logCard.head.append(log.search);
logCard.body.append(log.node);

page.append(
  el('div', { class: 'page-head' }, [el('h2', { text: 'Bots' }), el('div', { class: 'page-tools' }, [botCheck(load), periodBar(load, { ranges: ['24h', '3d'] })])]),
  periodNote,
  el('p', { class: 'period-note' }, [
    'Bot records are kept for the last 3 days; the daily log merge then deletes them for good. Until the bot check has run, today\'s requests count as bots only by user agent. ',
    el('a', { href: '/detect-bot', text: 'How bots are detected' }), ' · ', el('a', { href: '/abuse-check', text: 'AbuseIPDB check' }), '.',
  ]),
  kpiBox,
  el('div', { class: 'grid grid-chart' }, [overTime.node, reasonCard.node]),
  siteCard.node,
  ipCard.node,
  agentCard.node,
  logCard.node,
);

const loadKpis = widget(kpiBox, () => records('summary'), ({ filters, rows }) => {
  const total = rows[0] || {};
  periodNote.textContent = `Showing bots only, ${periodText(filters)}.`;
  kpiBox.replaceChildren(kpis([
    ['Requests', fmt(total.requests), 'Requests from bots'],
    ['IP addresses', fmt(total.ips), 'Distinct bot IP addresses'],
    ['User agents', fmt(total.user_agents), 'Distinct user agents bots sent'],
    ['Sites', fmt(total.sites), 'Sites the bots visited'],
    ['Errors', fmt(total.errors), 'Responses with status 400 or higher'],
  ]));
});

const loadChart = widget(overTime.node, () => records('timeseries'), ({ filters, rows }) => {
  const keys = buckets(filters);
  overTime.body.replaceChildren(chart(keys, {
    unit: filters.unit,
    bars: series(keys, rows, 'requests'),
    line: series(keys, rows, 'ips'),
    barLabel: 'Requests',
    lineLabel: 'IPs',
  }));
});

const loadReasons = widget(reasonCard.node, () => records('reasons'), ({ rows }) => reasons.set(rows));
const loadSites = widget(siteCard.node, () => records('sites'), ({ rows }) => sites.set(rows));

function load() {
  setStatus('');
  loadKpis();
  loadChart();
  loadReasons();
  loadSites();
  ips.load();
  agents.load();
  log.load();
}

start(load);
