import {
  $, botsNote, botToggle, buckets, card, chart, countryName, countryNote, countryShort, el, filters, fmt, formatTime,
  ipLink, isBot, kpis, pagedTable, pageLink, part, periodBar, periodText, series, setStatus, siteLink, siteName,
  siteUrl, start, state, staticTable, uaColumns, visitorLink, widget,
} from './dash.js';
import { t } from './i18n.js';

// One page of one site: who viewed it and from which IP addresses.
const page = $('page');
const query = new URLSearchParams(location.search);
const site = query.get('site') || '';
const path = query.get('path') || '';

const home = el('a', { text: t('所有网站', 'All sites') });
const siteCrumb = el('a');
const openLink = el('a', { target: '_blank', rel: 'noopener noreferrer', text: t('打开页面 ↗', 'Open page ↗') });
const periodNote = el('p', { class: 'period-note' });
const kpiBox = el('div', { class: 'kpi-box' });
const overTime = card(t('浏览趋势', 'Views over time'));
const note = countryNote(load);
const scope = () => ({ site, path, ...filters() });

// What each “Arrived via” value means (others are the host of the page the link was on).
const SOURCE_HELP = {
  'WeChat Moments': t('从微信朋友圈打开（链接带有 from=timeline）', 'Opened from a WeChat Moments post (the link had from=timeline)'),
  'WeChat chat': t('从微信单聊打开（from=singlemessage）', 'Opened from a one-to-one WeChat chat (from=singlemessage)'),
  'WeChat group': t('从微信群聊打开（from=groupmessage）', 'Opened from a WeChat group chat (from=groupmessage)'),
  WeChat: t('在微信中从不带分享标记的链接打开（例如复制的链接或收藏）', 'Opened in WeChat from a link without a share tag (e.g. a copied link or a favourite)'),
};

const sourceCard = card(t('访客从哪里来', 'How visitors arrived'), { subtitle: t('按每位访客首次浏览此页面计', 'by each visitor’s first view of this page') });
const sources = staticTable({
  empty: t('此时段内没有人浏览此页面', 'No one viewed this page in this period'),
  columns: [
    { label: t('来源', 'Arrived via'), value: (r) => r.source, title: (r) => SOURCE_HELP[r.source] || (r.source === 'Direct' ? t('没有来源：手动输入、书签或从应用中打开', 'No referrer: typed, bookmarked, or opened from an app') : t('链接所在的页面', 'The page the link was on')), cls: 'nowrap' },
    { label: t('访客数', 'Visitors'), value: (r) => fmt(r.visitors), cls: 'dl-num' },
    { label: t('浏览量', 'Views'), value: (r) => fmt(r.views), cls: 'dl-num' },
  ],
});
sourceCard.body.append(sources.node);

// From the page script (traffic.<domain>/t/s.js), on sites that load it: one row per page view.
const seconds = (n) => (n === null || n === undefined || n === '' ? '' : n < 60 ? `${n} s` : `${Math.floor(n / 60)} min ${n % 60} s`);
const percent = (part, whole) => (whole > 0 ? `${Math.round((part * 100) / whole)}%` : '');
const readingCard = card(t('阅读', 'Reading'), { subtitle: t('来自页面脚本：页面在屏幕上显示的时长和滚动的深度', 'from the page script: time the page was on screen and how far it was scrolled') });
const readingKpis = el('div');
const bucketTable = (label) => staticTable({
  empty: t('没有报告', 'No reports'),
  columns: [
    { label, value: (r) => r.bucket.slice(2), cls: 'nowrap' },
    { label: t('浏览量', 'Views'), value: (r) => fmt(r.views), cls: 'dl-num' },
    { label: t('占比', 'Share'), value: (r) => r.share, cls: 'dl-num dl-muted' },
  ],
});
const timeBuckets = bucketTable(t('停留时长', 'Time on page'));
const scrollBuckets = bucketTable(t('滚动到', 'Scrolled to'));
readingCard.body.append(readingKpis, el('div', { class: 'grid grid-pair' }, [timeBuckets.node, scrollBuckets.node]));

const readsCard = card(t('阅读记录', 'Page views read'), { subtitle: t('页面脚本报告的最近 100 次浏览', 'latest 100 page views reported by the page script') });
const reads = staticTable({
  empty: t('此时段内没有报告（该网站可能未加载页面脚本）', 'No reports in this period (the site may not load the page script)'),
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: t('时间', 'Time'), value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: t('访客 ID', 'Visitor ID'), value: (r) => (r.visitor.startsWith('ip:') ? t('无 cookie', 'No cookie') : r.visitor), href: (r) => (r.visitor.startsWith('ip:') ? null : visitorLink(r.visitor)), cls: 'nowrap' },
    { label: t('IP 地址', 'IP address'), value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: t('国家/地区', 'Country'), value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: t('显示时长', 'On screen'), value: (r) => seconds(Number(r.seconds)), cls: 'dl-num nowrap' },
    { label: t('滚动深度', 'Scrolled'), value: (r) => `${r.scroll}%`, cls: 'dl-num' },
    { label: t('屏幕', 'Screen'), value: (r) => screenText(r.screen), title: () => t('屏幕宽 × 高（CSS 像素）及像素比', 'Screen width × height in CSS pixels, and pixel ratio'), cls: 'nowrap dl-muted' },
    { label: t('加载', 'Load'), value: (r) => (r.load_ms ? `${(Number(r.load_ms) / 1000).toFixed(1)} s` : ''), title: () => t('页面加载完成所用的时间', 'Time until the page finished loading'), cls: 'dl-num dl-muted' },
    { label: t('错误', 'Errors'), value: (r) => (Number(r.errors) ? r.errors : ''), title: () => t('页面上的脚本错误', 'Script errors on the page'), cls: 'dl-num' },
    ...uaColumns('ua'),
  ],
});
readsCard.body.append(reads.node);

// 390x844x300 -> 390×844 @3x
function screenText(value) {
  const m = /^(\d+)x(\d+)x(\d+)$/.exec(value || '');
  return m ? `${m[1]}×${m[2]} @${Number(m[3]) / 100}x` : '';
}

const visitorCard = card(t('访客', 'Visitors'), { subtitle: t('浏览过此页面的访客，按 dl_vid cookie 区分（没有 cookie 时按 IP）', 'who viewed this page, by dl_vid cookie (or IP without one)') });
const visitors = pagedTable({
  list: 'page_visitors',
  params: scope,
  pageSize: 20,
  placeholder: t('搜索访客 ID、IP、国家/地区、城市、User-Agent…', 'Search visitor ID, IP, country, city, user agent…'),
  empty: t('此时段内没有人浏览此页面', 'No one viewed this page in this period'),
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: t('访客 ID', 'Visitor ID'), value: (r) => r.visitor_id || t('无 cookie', 'No cookie'), href: (r) => (r.visitor_id ? visitorLink(r.visitor_id) : null), title: (r) => (r.visitor_id ? null : t('按 IP 地址计：浏览器从未回传 dl_vid cookie', 'Counted by IP address: the browser never sent the dl_vid cookie back')), cls: 'nowrap' },
    { label: t('最近 IP', 'Last IP'), value: (r) => r.last_ip, href: (r) => ipLink(r.last_ip), cls: 'nowrap' },
    { label: t('IP 数', 'IPs'), value: (r) => fmt(r.ips), cls: 'dl-num' },
    { label: t('国家/地区', 'Country'), value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: t('城市', 'City'), value: (r) => r.city || '', cls: 'nowrap' },
    { label: t('浏览量', 'Views'), value: (r) => fmt(r.views), cls: 'dl-num' },
    { label: t('来源', 'Arrived via'), value: (r) => r.source || '', title: (r) => SOURCE_HELP[r.source] || null, cls: 'nowrap' },
    { label: t('最近浏览', 'Last viewed'), value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: t('首次浏览', 'First viewed'), value: (r) => formatTime(r.first_seen), cls: 'nowrap dl-muted' },
    ...uaColumns('last_ua'),
  ],
});
visitorCard.head.append(visitors.search);
visitorCard.body.append(visitors.node);

const ipCard = card(t('IP 地址', 'IP addresses'), { subtitle: t('点击 IP 查看它的全部活动', 'click an IP to see everything it did') });
const ips = pagedTable({
  list: 'page_ips',
  params: scope,
  pageSize: 20,
  placeholder: t('搜索 IP、国家/地区、城市、User-Agent…', 'Search IP, country, city, user agent…'),
  empty: t('此时段内没有 IP 地址浏览此页面', 'No IP addresses viewed this page in this period'),
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: t('IP 地址', 'IP address'), value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: t('国家/地区', 'Country'), value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: t('城市', 'City'), value: (r) => r.city || '', cls: 'nowrap' },
    { label: t('浏览量', 'Views'), value: (r) => fmt(r.views), cls: 'dl-num' },
    { label: t('访客数', 'Visitors'), value: (r) => fmt(r.visitors), cls: 'dl-num' },
    { label: t('最近浏览', 'Last viewed'), value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: t('首次浏览', 'First viewed'), value: (r) => formatTime(r.first_seen), cls: 'nowrap dl-muted' },
    ...uaColumns('last_ua'),
  ],
});
ipCard.head.append(ips.search);
ipCard.body.append(ips.node);

const logCard = card(t('请求', 'Requests'), { subtitle: t('此路径的所有请求，最新的在前', 'every request for this path, newest first') });
const log = pagedTable({
  list: 'requests',
  params: scope,
  pageSize: 20,
  placeholder: t('搜索 IP、城市、状态码、User-Agent…', 'Search IP, city, status, user agent…'),
  empty: t('没有请求', 'No requests'),
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: t('时间', 'Time'), value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: t('IP 地址', 'IP address'), value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: t('国家/地区', 'Country'), value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: t('城市', 'City'), value: (r) => r.city || '', cls: 'nowrap' },
    { label: t('访客 ID', 'Visitor ID'), value: (r) => r.visitor_id || '', href: (r) => visitorLink(r.visitor_id), cls: 'nowrap dl-muted' },
    { label: t('方法', 'Method'), value: (r) => r.method },
    { label: t('状态码', 'Status'), value: (r) => r.status, cls: 'dl-num' },
    { label: t('来源', 'Referrer'), value: (r) => r.referrer, cls: 'wrap dl-muted' },
    ...uaColumns('ua'),
  ],
});
logCard.head.append(log.search);
logCard.body.append(log.node);

page.append(
  el('p', { class: 'crumbs' }, [home, ' › ', siteCrumb, t(' › 页面', ' › Page')]),
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
  periodNote.textContent = t(`时段：${periodText(f)}。${botsNote()}`, `Showing ${periodText(f)}. ${botsNote()}`);
  kpiBox.replaceChildren(kpis([
    [t('浏览量', 'Views'), fmt(s.views), t('此页面的加载次数', 'Loads of this page')],
    [t('访客数', 'Visitors'), fmt(s.visitors), t('去重访客：按 dl_vid cookie 计，没有 cookie 时按 IP 计', 'Distinct visitors: the dl_vid cookie, or the IP when there is no cookie')],
    [t('IP 地址', 'IP addresses'), fmt(s.ips), t('浏览此页面的去重 IP 数', 'Distinct IPs this page was viewed from')],
    [t('国家/地区数', 'Countries'), fmt(s.countries)],
  ]));
});

const loadSources = widget(sourceCard.node, () => pagePart('sources'), ({ rows }) => sources.set(rows));

const loadReading = widget(readingKpis, () => pagePart('reading'), ({ rows }) => {
  const r = rows[0] || {};
  const views = Number(r.views || 0);
  readingKpis.replaceChildren(kpis([
    [t('已报告的浏览', 'Views reported'), fmt(r.views), t('页面脚本报告的浏览次数（除非显示机器人，否则不含机器人）', 'Page views the page script reported (bots left out unless shown)')],
    [t('时长中位数', 'Median time'), views ? seconds(Number(r.median_seconds)) : '–', t('一半浏览的页面显示时长少于此值', 'Half of the views had the page on screen for less than this')],
    [t('平均时长', 'Average time'), views ? seconds(Number(r.average_seconds)) : '–', t('页面在屏幕上显示的时长，按浏览次数平均', 'Time the page was on screen, averaged over views')],
    [t('读到结尾', 'Read to the end'), views ? percent(Number(r.read_to_end), views) : '–', t('滚动到页面至少 90% 处的浏览', 'Views scrolled to at least 90% of the page')],
    [t('滚动深度中位数', 'Median scroll'), views ? `${r.median_scroll}%` : '–', t('一半浏览达到的滚动深度', 'How far down half of the views reached')],
    [t('加载时间中位数', 'Median load'), r.median_load_ms ? `${(Number(r.median_load_ms) / 1000).toFixed(1)} s` : '–', t('页面加载完成所用的时间', 'Time until the page finished loading')],
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
    barLabel: t('浏览量', 'Views'),
    lineLabel: t('访客数', 'Visitors'),
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
  document.title = `${path} · ${state.siteHosts[site]} · ${t('流量', 'Traffic')}`;
  load();
});
