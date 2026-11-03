import {
  $, botReasonText, card, countryLabel, countryName, countryShort, describeBrowser, describeDevice, el, facts, fmt,
  formatTime, hostingName, ipLink, isBot, kpis, pageDetailsLink, pagedTable, pageLink, part, period, periodBar,
  periodText, setStatus, siteLink, siteName, start, staticTable, uaColumns, uaTitle, VISITOR_PATTERN, widget,
} from './dash.js';
import { t } from './i18n.js';

// Everything one dl_vid visitor ID did, across every site and IP address.
const page = $('page');
const visitor = new URLSearchParams(location.search).get('visitor') || '';

const home = el('a', { text: t('所有网站', 'All sites') });
const title = el('h2', {}, [visitor]);
const periodNote = el('p', { class: 'period-note' });
const kpiBox = el('div', { class: 'kpi-box' });
const aboutCard = card(t('关于此访客', 'About this visitor'));
const summaryBox = el('div', {}, [kpiBox, aboutCard.node]);

const sitesCard = card(t('访问过的网站', 'Sites visited'));
const sites = staticTable({
  empty: t('此访客在此时段内没有请求', 'No requests from this visitor in this period'),
  columns: [
    { label: t('网站', 'Site'), value: (r) => siteName(r.site), href: (r) => siteLink(r.site) },
    { label: t('浏览量', 'Page views'), value: (r) => fmt(r.pageviews), cls: 'dl-num' },
    { label: t('请求', 'Requests'), value: (r) => fmt(r.requests), cls: 'dl-num' },
    { label: t('首次出现', 'First seen'), value: (r) => formatTime(r.first_seen), cls: 'nowrap dl-muted' },
    { label: t('最后出现', 'Last seen'), value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
  ],
});
sitesCard.body.append(sites.node);

const scope = () => ({ site: 'all', visitor, ...period() });

const ipsCard = card(t('IP 地址', 'IP addresses'), { subtitle: t('此访客 ID 出现过的 IP', 'IPs this visitor ID was seen on') });
const ips = pagedTable({
  list: 'visitor_ips',
  params: scope,
  pageSize: 10,
  placeholder: t('搜索 IP、网站、城市、User-Agent…', 'Search IP, site, city, user agent…'),
  empty: t('没有 IP 地址', 'No IP addresses'),
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: t('IP 地址', 'IP address'), value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: t('国家/地区', 'Country'), value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: t('城市', 'City'), value: (r) => r.city || '', cls: 'nowrap' },
    { label: t('最后出现', 'Last seen'), value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: t('网站', 'Sites'), value: (r) => (r.sites || '').split(',').filter(Boolean).map(siteName).join(', ') },
    { label: t('浏览量', 'Page views'), value: (r) => fmt(r.pageviews), cls: 'dl-num' },
    ...uaColumns('last_ua'),
  ],
});
ipsCard.head.append(ips.search);
ipsCard.body.append(ips.node);

const pagesCard = card(t('访问过的页面', 'Pages visited'), { subtitle: t('最新的在前', 'most recent first') });
const pages = pagedTable({
  list: 'visitor_pages',
  params: scope,
  pageSize: 20,
  placeholder: t('搜索页面、网站…', 'Search page, site…'),
  empty: t('没有浏览记录', 'No page views'),
  columns: [
    { label: t('网站', 'Site'), value: (r) => siteName(r.site), cls: 'nowrap' },
    { label: t('页面', 'Page'), value: (r) => r.path, href: (r) => pageDetailsLink(r.site, r.path), cls: 'wrap' },
    { label: t('浏览量', 'Views'), value: (r) => fmt(r.views), cls: 'dl-num' },
    { label: t('首次出现', 'First seen'), value: (r) => formatTime(r.first_seen), cls: 'nowrap dl-muted' },
    { label: t('最后出现', 'Last seen'), value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
  ],
});
pagesCard.head.append(pages.search);
pagesCard.body.append(pages.node);

// From the page script, on sites that load it: how long each page view was on screen.
const seconds = (n) => (!Number.isFinite(n) ? '' : n < 60 ? `${n} s` : n < 3600 ? `${Math.floor(n / 60)} min ${n % 60} s`
  : `${Math.floor(n / 3600)} h ${Math.floor((n % 3600) / 60)} min`);
const readingCard = card(t('阅读', 'Reading'), { subtitle: t('页面脚本上报的浏览，最新的在前', 'page views reported by the page script, newest first') });
const readingNote = el('p', { class: 'dl-muted' });
const reading = staticTable({
  empty: t('此时段内没有上报（只有加载了页面脚本的网站才会上报阅读情况）', 'No reports in this period (only sites that load the page script report reading)'),
  columns: [
    { label: t('时间', 'Time'), value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: t('网站', 'Site'), value: (r) => siteName(r.site), cls: 'nowrap' },
    { label: t('页面', 'Page'), value: (r) => r.path, href: (r) => pageDetailsLink(r.site, r.path), cls: 'wrap' },
    { label: t('屏幕停留', 'On screen'), value: (r) => seconds(Number(r.seconds)), title: () => t('页面在屏幕上可见的时长', 'Time the page was visible on screen'), cls: 'dl-num nowrap' },
    { label: t('滚动', 'Scrolled'), value: (r) => `${r.scroll}%`, title: () => t('滚动到的最远位置', 'Furthest point scrolled to'), cls: 'dl-num' },
    { label: t('屏幕', 'Screen'), value: (r) => screenText(r.screen), title: () => t('屏幕宽 × 高（CSS 像素）及像素比', 'Screen width × height in CSS pixels, and pixel ratio'), cls: 'nowrap dl-muted' },
    { label: t('IP 地址', 'IP address'), value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap dl-muted' },
  ],
});
readingCard.body.append(readingNote, reading.node);

// 390x844x300 -> 390×844 @3x
function screenText(value) {
  const m = /^(\d+)x(\d+)x(\d+)$/.exec(value || '');
  return m ? `${m[1]}×${m[2]} @${Number(m[3]) / 100}x` : '';
}

const logCard = card(t('请求', 'Requests'), { subtitle: t('最新的在前', 'newest first') });
const log = pagedTable({
  list: 'requests',
  params: scope,
  pageSize: 50,
  placeholder: t('搜索路径、网站、IP、状态码…', 'Search path, site, IP, status…'),
  empty: t('没有请求', 'No requests'),
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: t('时间', 'Time'), value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: t('网站', 'Site'), value: (r) => siteName(r.site), cls: 'nowrap' },
    { label: t('IP 地址', 'IP address'), value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: t('方法', 'Method'), value: (r) => r.method },
    { label: t('路径', 'Path'), value: (r) => r.path, cls: 'wrap' },
    { label: t('状态', 'Status'), value: (r) => r.status, cls: 'dl-num' },
    { label: t('来源', 'Referrer'), value: (r) => r.referrer, cls: 'wrap dl-muted' },
    ...uaColumns('ua', false),
  ],
});
logCard.head.append(log.search);
logCard.body.append(log.node);

page.append(
  el('p', { class: 'crumbs' }, [home, t(' › 访客', ' › Visitor')]),
  el('div', { class: 'page-head' }, [title, periodBar(load)]),
  periodNote,
  summaryBox,
  el('div', { class: 'grid grid-pair' }, [sitesCard.node, ipsCard.node]),
  pagesCard.node,
  readingCard.node,
  logCard.node,
);

const loadSummary = widget(summaryBox, () => part('/api/visitor', 'summary', { visitor, ...period() }), ({ filters, rows }) => {
  const s = rows[0] || {};
  const seen = Number(s.requests) > 0;
  periodNote.textContent = t(`显示 ${periodText(filters)}，涵盖所有网站和 IP 地址，含机器人。`, `Showing ${periodText(filters)} across all sites and IP addresses, bots included.`);
  title.replaceChildren(visitor, seen ? el('span', { class: `tag${isBot(s) ? ' bot' : ''}`, text: isBot(s) ? t('机器人', 'Bot') : t('真人', 'Person') }) : null);
  kpiBox.replaceChildren(kpis([
    [t('浏览量', 'Page views'), fmt(s.pageviews), t('HTML 页面加载次数', 'HTML page loads')],
    [t('请求', 'Requests'), fmt(s.requests), t('全部请求，包括静态资源', 'Everything, including assets')],
    [t('网站', 'Sites'), fmt(s.sites)],
    [t('IP 地址', 'IP addresses'), fmt(s.ips)],
    [t('活跃天数', 'Days active'), fmt(s.days), t('至少有一次请求的天数（UTC）', 'UTC days with at least one request')],
  ]));
  const countries = Number(s.countries) || 0;
  aboutCard.body.replaceChildren(facts([
    [t('最新 IP', 'Latest IP'), s.last_ip || ''],
    [t('国家/地区', 'Country'), s.country ? `${countryLabel(s.country)}${countries > 1 ? t(`（此时段内共 ${countries} 个国家/地区）`, ` (${countries} countries in this period)`) : ''}` : (seen ? t('未记录', 'Not recorded') : '')],
    [t('城市', 'City'), s.city || (seen ? t('未记录', 'Not recorded') : ''), s.city ? t('CloudFront 判定此访客最近所在的城市（大致）；“(DB-IP)”表示来自 DB-IP 的数据库', 'Latest city CloudFront placed this visitor in (approximate); “(DB-IP)” means it comes from DB-IP’s database') : null],
    [t('网络', 'Network'), s.asn ? `AS${s.asn}${hostingName(s.asn) ? t(` · ${hostingName(s.asn)}（托管网络）`, ` · ${hostingName(s.asn)} (hosting network)`) : ''}` : (seen ? t('未记录', 'Not recorded') : '')],
    [t('判定为机器人', 'Counted as a bot'), seen ? (botReasonText(s.bot_reasons) || t('否', 'No')) : '',
      t('爬虫 User-Agent 立即计入；其他原因来自每 6 小时一次的机器人检查', 'Crawler user agents count at once; the other reasons come from the bot check every 6 hours')],
    [t('首次出现', 'First seen'), seen ? formatTime(s.first_seen) : ''],
    [t('最后出现', 'Last seen'), seen ? formatTime(s.last_seen) : ''],
    [t('最新浏览器', 'Latest browser'), describeBrowser(s.last_ua), s.last_ua],
      [t('最新设备', 'Latest device'), describeDevice(s.last_ua, s.last_hints), uaTitle(s.last_ua, s.last_hints)],
    [t('不同浏览器数', 'Different browsers'), seen ? fmt(s.user_agents) : ''],
    [t('错误', 'Errors'), seen ? fmt(s.errors) : ''],
  ]));
  setStatus(seen ? '' : t('此访客在此时段内没有请求，请尝试更长的时段。', 'This visitor made no requests in this period. Try a longer period.'));
});

const loadSites = widget(sitesCard.node, () => part('/api/visitor', 'sites', { visitor, ...period() }), ({ rows }) => sites.set(rows));

const loadReading = widget(readingCard.node, () => part('/api/visitor', 'reading', { visitor, ...period() }), ({ rows }) => {
  const r = rows[0];
  const views = r ? Number(r.total_views) : 0;
  readingNote.textContent = views
    ? t(`共阅读 ${fmt(views)} 次浏览，屏幕停留合计 ${seconds(Number(r.total_seconds))}${views > rows.length ? `（显示最新 ${rows.length} 条）` : ''}。`,
      `${fmt(views)} page view${views === 1 ? '' : 's'} read, ${seconds(Number(r.total_seconds))} on screen in total${views > rows.length ? ` (latest ${rows.length} shown)` : ''}.`)
    : '';
  reading.set(rows);
});

function load() {
  home.setAttribute('href', pageLink('/'));
  setStatus('');
  loadSummary();
  loadSites();
  loadReading();
  for (const table of [ips, pages, log]) table.load();
}

start(async () => {
  if (!VISITOR_PATTERN.test(visitor)) {
    location.replace(pageLink('/'));
    return;
  }
  document.title = t(`${visitor} · 流量`, `${visitor} · Traffic`);
  load();
});
