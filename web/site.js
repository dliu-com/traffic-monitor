import {
  $, botsNote, botToggle, buckets, card, chart, countriesTable, countryName, countryNote, countrySelect, countryShort,
  el, filters, fmt, formatTime, ipLink, isBot, kpis, pageDetailsLink, pagedTable, pageLink, part, periodBar,
  periodText, series, setStatus, siteName, start, state, uaColumns, updatedNote, widget,
} from './dash.js';
import { t } from './i18n.js';

const page = $('page');
const site = new URLSearchParams(location.search).get('site') || '';

function checkbox(label, checked) {
  const input = el('input', { type: 'checkbox', checked });
  return { input, node: el('label', {}, [input, ` ${label}`]) };
}

const switcher = el('select', { 'aria-label': t('选择网站', 'Choose a site') });
const crumb = el('span');
const home = el('a', { text: t('所有网站', 'All sites') });
const openLink = el('a', { target: '_blank', rel: 'noopener noreferrer', text: t('打开网站 ↗', 'Open site ↗') });
const periodNote = el('p', { class: 'period-note' });
const kpiBox = el('div', { class: 'kpi-box' });
const overTime = card(t('访问趋势', 'Visits over time'));

const pagesCard = card(t('热门页面', 'Top pages'));
const scope = () => ({ site, ...filters() });
const countryCard = card(t('国家/地区', 'Countries'), { subtitle: t('点击可筛选', 'click one to filter') });
const countries = countriesTable(scope);
countryCard.head.append(countries.search);
countryCard.body.append(countries.node);
const picker = countrySelect(scope, load);
const note = countryNote(load);
const pages = pagedTable({
  list: 'pages',
  params: scope,
  pageSize: 10,
  placeholder: t('搜索页面或粘贴 URL…', 'Search pages or paste a URL…'),
  empty: t('没有浏览', 'No page views'),
  searchUrls: true,
  columns: [
    { label: t('页面', 'Page'), value: (r) => r.path, href: (r) => pageDetailsLink(site, r.path), external: true, title: () => t('此页面的访客和 IP 地址', 'Visitors and IP addresses of this page'), cls: 'wrap' },
    { label: t('浏览量', 'Views'), value: (r) => fmt(r.views), cls: 'dl-num' },
    { label: t('访客数', 'Visitors'), value: (r) => fmt(r.visitors), cls: 'dl-num' },
  ],
});
pagesCard.head.append(pages.search);
pagesCard.body.append(pages.node);

const refCard = card(t('外部来源', 'External referrers'));
const referrers = pagedTable({
  list: 'referrers',
  params: scope,
  pageSize: 10,
  placeholder: t('搜索来源…', 'Search referrers…'),
  empty: t('没有外部来源', 'No external referrers'),
  columns: [
    { label: t('来源', 'Referrer'), value: (r) => r.referrer || t('（未知）', '(unknown)'), cls: 'wrap' },
    { label: t('浏览量', 'Views'), value: (r) => fmt(r.views), cls: 'dl-num' },
    { label: t('访客数', 'Visitors'), value: (r) => fmt(r.visitors), cls: 'dl-num' },
  ],
});
refCard.head.append(referrers.search);
refCard.body.append(referrers.node);

const ipCard = card(t('IP 地址', 'IP addresses'), { subtitle: t('点击 IP 查看它的全部活动', 'click an IP to see everything it did'), className: 'private-only' });
const ips = pagedTable({
  list: 'ips',
  params: scope,
  pageSize: 20,
  placeholder: t('搜索 IP、国家/地区、城市、User-Agent…', 'Search IP, country, city, user agent…'),
  empty: t('此时段内没有访客', 'No visitors in this period'),
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: t('IP 地址', 'IP address'), value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: t('国家/地区', 'Country'), value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: t('城市', 'City'), value: (r) => r.city || '', cls: 'nowrap' },
    { label: t('最近访问', 'Last seen'), value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: t('浏览量', 'Page views'), value: (r) => fmt(r.pageviews), cls: 'dl-num' },
    { label: t('请求数', 'Requests'), value: (r) => fmt(r.requests), cls: 'dl-num' },
    ...uaColumns('last_ua'),
    { label: t('首次访问', 'First seen'), value: (r) => formatTime(r.first_seen), cls: 'nowrap dl-muted' },
  ],
});
ipCard.head.append(ips.search);
ipCard.body.append(ips.node);

const pagesOnly = checkbox(t('仅页面', 'Pages only'), false);
const logCard = card(t('请求日志', 'Request log'), { subtitle: t('最新的在前', 'newest first'), className: 'private-only' });
const log = pagedTable({
  list: 'requests',
  params: () => ({ ...scope(), ...(pagesOnly.input.checked ? { pages: 'only' } : {}) }),
  pageSize: 20,
  placeholder: t('搜索路径、URL、IP、城市、状态码、User-Agent…', 'Search path, URL, IP, city, status, user agent…'),
  empty: t('没有请求', 'No requests'),
  searchUrls: true,
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: t('时间', 'Time'), value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: t('IP 地址', 'IP address'), value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: t('国家/地区', 'Country'), value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: t('城市', 'City'), value: (r) => r.city || '', cls: 'nowrap' },
    { label: t('方法', 'Method'), value: (r) => r.method },
    { label: t('路径', 'Path'), value: (r) => r.path, cls: 'wrap' },
    { label: t('状态码', 'Status'), value: (r) => r.status, cls: 'dl-num' },
    { label: t('来源', 'Referrer'), value: (r) => r.referrer, cls: 'wrap dl-muted' },
    ...uaColumns('ua'),
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
  periodNote.textContent = t(`时段：${periodText(filters)}。${botsNote()}${updatedNote(filters)}`, `Showing ${periodText(filters)}. ${botsNote()}${updatedNote(filters)}`);
  kpiBox.replaceChildren(kpis([
    [t('访客数', 'Visitors'), fmt(total.visitors), t('去重访客：按 dl_vid cookie 计，没有 cookie 时按 IP 计', 'Distinct visitors: the dl_vid cookie, or the IP when there is no cookie')],
    [t('浏览量', 'Page views'), fmt(total.pageviews), t('HTML 页面加载次数', 'HTML page loads')],
    [t('IP 地址', 'IP addresses'), fmt(total.ips), t('去重 IP 地址数', 'Distinct IP addresses')],
    [t('请求数', 'Requests'), fmt(total.requests), t('全部请求，包括静态资源', 'Everything, including assets')],
    [t('错误', 'Errors'), fmt(total.errors), t('状态码为 400 及以上的响应', 'Responses with status 400 or higher')],
  ]));
});

const loadChart = widget(overTime.node, () => overview('timeseries'), ({ filters, rows }) => {
  const keys = buckets(filters);
  overTime.body.replaceChildren(chart(keys, {
    unit: filters.unit,
    bars: series(keys, rows, 'pageviews'),
    line: series(keys, rows, 'visitors'),
    barLabel: t('浏览量', 'Page views'),
    lineLabel: t('访客数', 'Visitors'),
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
  document.title = `${state.siteHosts[site]} · ${t('流量', 'Traffic')}`;
  load();
}, { publicView: true });
