// The Bots page (signed in only): what the requests judged to be bots did. Bot records are kept for the
// last 3 days; the daily log merge then deletes them, so older periods only show what is left.
import {
  $, BOT_REASONS, botCheck, botReasonText, buckets, card, chart, countryName, countryShort, el, filters, fmt,
  formatTime, ipLink, kpis, pagedTable, part, periodBar, periodText, series, setStatus, siteName, start, state,
  staticTable, uaColumns, widget,
} from './dash.js';
import { t } from './i18n.js';

state.defaultRange = '3d';
const page = $('page');
const periodNote = el('p', { class: 'period-note' });
const kpiBox = el('div', { class: 'kpi-box' });
const overTime = card(t('机器人请求趋势', 'Bot requests over time'));
const scope = () => ({ site: 'all', ...filters(), bots: 'only' });
const records = (name) => part('/api/bot-records', name, scope());
const reasonLabel = (reason) => (Object.hasOwn(BOT_REASONS, reason) ? BOT_REASONS[reason] : reason || '');

const reasonCard = card(t('判定为机器人的原因', 'Why they count as bots'));
const reasons = staticTable({
  empty: t('此时段内没有机器人', 'No bots in this period'),
  columns: [
    { label: t('原因', 'Reason'), value: (r) => reasonLabel(r.reason) },
    { label: t('请求', 'Requests'), value: (r) => fmt(r.requests), cls: 'dl-num' },
    { label: t('IP 数', 'IPs'), value: (r) => fmt(r.ips), cls: 'dl-num' },
  ],
});
reasonCard.body.append(reasons.node);

const siteCard = card(t('网站', 'Sites'));
const sites = staticTable({
  empty: t('此时段内没有机器人', 'No bots in this period'),
  columns: [
    { label: t('网站', 'Site'), value: (r) => siteName(r.site) },
    { label: t('请求', 'Requests'), value: (r) => fmt(r.requests), cls: 'dl-num' },
    { label: t('IP 数', 'IPs'), value: (r) => fmt(r.ips), cls: 'dl-num' },
    { label: t('最近出现', 'Last seen'), value: (r) => formatTime(r.last_seen), cls: 'nowrap dl-muted' },
  ],
});
siteCard.body.append(sites.node);

const ipCard = card(t('机器人 IP 地址', 'Bot IP addresses'), { subtitle: t('点击 IP 查看它的全部活动', 'click an IP to see everything it did') });
const ips = pagedTable({
  list: 'ips',
  params: scope,
  pageSize: 15,
  placeholder: t('搜索 IP、网站、国家/地区、城市、User-Agent…', 'Search IP, site, country, city, user agent…'),
  empty: t('此时段内没有机器人', 'No bots in this period'),
  columns: [
    { label: t('IP 地址', 'IP address'), value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: t('原因', 'Why'), value: (r) => botReasonText(r.bot_reason) },
    { label: t('国家/地区', 'Country'), value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: t('最近出现', 'Last seen'), value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: t('网站', 'Sites'), value: (r) => (r.sites || '').split(',').filter(Boolean).map(siteName).join(', ') },
    { label: t('请求', 'Requests'), value: (r) => fmt(r.requests), cls: 'dl-num' },
    ...uaColumns('last_ua'),
  ],
});
ipCard.head.append(ips.search);
ipCard.body.append(ips.node);

const agentCard = card(t('User-Agent', 'User agents'));
const agents = pagedTable({
  list: 'agents',
  params: scope,
  pageSize: 10,
  placeholder: t('搜索 User-Agent 或网站…', 'Search user agents or sites…'),
  empty: t('此时段内没有机器人', 'No bots in this period'),
  columns: [
    { label: t('User-Agent', 'User agent'), value: (r) => (r.ua && r.ua !== '-' ? r.ua : t('（无）', '(none)')), cls: 'wrap' },
    { label: t('请求', 'Requests'), value: (r) => fmt(r.requests), cls: 'dl-num' },
    { label: t('IP 数', 'IPs'), value: (r) => fmt(r.ips), cls: 'dl-num' },
    { label: t('网站', 'Sites'), value: (r) => (r.sites || '').split(',').filter(Boolean).map(siteName).join(', ') },
    { label: t('最近出现', 'Last seen'), value: (r) => formatTime(r.last_seen), cls: 'nowrap dl-muted' },
  ],
});
agentCard.head.append(agents.search);
agentCard.body.append(agents.node);

const logCard = card(t('机器人请求', 'Bot requests'), { subtitle: t('最新的在前', 'newest first') });
const log = pagedTable({
  list: 'requests',
  params: scope,
  pageSize: 20,
  placeholder: t('搜索网站、IP、路径、状态码、User-Agent…', 'Search site, IP, path, status, user agent…'),
  empty: t('此时段内没有机器人', 'No bots in this period'),
  columns: [
    { label: t('时间', 'Time'), value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: t('网站', 'Site'), value: (r) => siteName(r.site), cls: 'nowrap' },
    { label: t('IP 地址', 'IP address'), value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: t('原因', 'Why'), value: (r) => reasonLabel(r.bot_reason) },
    { label: t('请求', 'Request'), value: (r) => `${r.method} ${r.path}`, cls: 'wrap' },
    { label: t('状态码', 'Status'), value: (r) => r.status, cls: 'dl-num' },
    ...uaColumns('ua'),
  ],
});
logCard.head.append(log.search);
logCard.body.append(log.node);

page.append(
  el('div', { class: 'page-head' }, [el('h2', { text: t('机器人', 'Bots') }), el('div', { class: 'page-tools' }, [botCheck(load), periodBar(load, { ranges: ['24h', '3d'] })])]),
  periodNote,
  el('p', { class: 'period-note' }, [
    t('机器人记录只保留最近 3 天，之后每日日志合并会将其永久删除。在下一次机器人检查（每 6 小时一次）之前，新请求只按 User-Agent 判定是否为机器人。', 'Bot records are kept for the last 3 days; the daily log merge then deletes them for good. Until the next bot check (every 6 hours), new requests count as bots only by user agent. '),
    el('a', { href: '/docs#bot-detection', text: t('机器人识别方法', 'How bots are detected') }), ' · ', el('a', { href: '/abuse-check', text: t('AbuseIPDB 检查', 'AbuseIPDB check') }), t('。', '.'),
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
  periodNote.textContent = t(`仅显示机器人，${periodText(filters)}。`, `Showing bots only, ${periodText(filters)}.`);
  kpiBox.replaceChildren(kpis([
    [t('请求', 'Requests'), fmt(total.requests), t('来自机器人的请求', 'Requests from bots')],
    [t('IP 地址', 'IP addresses'), fmt(total.ips), t('不同的机器人 IP 地址数', 'Distinct bot IP addresses')],
    [t('User-Agent', 'User agents'), fmt(total.user_agents), t('机器人发送的不同 User-Agent 数', 'Distinct user agents bots sent')],
    [t('网站', 'Sites'), fmt(total.sites), t('机器人访问过的网站', 'Sites the bots visited')],
    [t('错误', 'Errors'), fmt(total.errors), t('状态码为 400 及以上的响应', 'Responses with status 400 or higher')],
  ]));
});

const loadChart = widget(overTime.node, () => records('timeseries'), ({ filters, rows }) => {
  const keys = buckets(filters);
  overTime.body.replaceChildren(chart(keys, {
    unit: filters.unit,
    bars: series(keys, rows, 'requests'),
    line: series(keys, rows, 'ips'),
    barLabel: t('请求', 'Requests'),
    lineLabel: t('IP 数', 'IPs'),
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
