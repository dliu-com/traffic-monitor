import {
  $, botsNote, bucketOf, buckets, card, chart, countriesTable, countryName, countryNote, countrySelect, countryShort,
  el, filters, fmt, formatTime, handleError, ipLink, isBot, kpis, pagedTable, part, periodBar, periodText, series,
  setStatus, siteLink, siteName, sparkline, start, state, uaColumns, updatedNote, widget,
} from './dash.js';
import { t } from './i18n.js';

const page = $('page');
const periodNote = el('p', { class: 'period-note' });
const kpiBox = el('div', { class: 'kpi-box' });
const overTime = card(t('访问趋势', 'Visits over time'));
const scope = () => ({ site: 'all', ...filters() });
const countryCard = card(t('国家/地区', 'Countries'), { subtitle: t('点击可筛选', 'click one to filter') });
const countries = countriesTable(scope);
countryCard.head.append(countries.search);
countryCard.body.append(countries.node);
const picker = countrySelect(scope, load);
const note = countryNote(load);
const sitesBox = el('div', { class: 'site-cards' });
const ipCard = card(t('最近的 IP 地址', 'Latest IP addresses'), { subtitle: t('点击 IP 查看它的全部活动', 'click an IP to see everything it did'), className: 'private-only' });
const ips = pagedTable({
  list: 'ips',
  params: scope,
  pageSize: 15,
  placeholder: t('搜索 IP、网站、国家/地区、城市、User-Agent…', 'Search IP, site, country, city, user agent…'),
  empty: t('此时段内没有访客', 'No visitors in this period'),
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: t('IP 地址', 'IP address'), value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: t('国家/地区', 'Country'), value: (r) => countryShort(r.country), title: (r) => (r.country ? countryName(r.country) : null), cls: 'nowrap' },
    { label: t('城市', 'City'), value: (r) => r.city || '', cls: 'nowrap' },
    { label: t('最近访问', 'Last seen'), value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: t('网站', 'Sites'), value: (r) => (r.sites || '').split(',').filter(Boolean).map(siteName).join(', ') },
    { label: t('浏览量', 'Page views'), value: (r) => fmt(r.pageviews), cls: 'dl-num' },
    { label: t('请求数', 'Requests'), value: (r) => fmt(r.requests), cls: 'dl-num' },
    ...uaColumns('last_ua'),
    { label: t('首次访问', 'First seen'), value: (r) => formatTime(r.first_seen), cls: 'nowrap dl-muted' },
  ],
});
ipCard.head.append(ips.search);
ipCard.body.append(ips.node);

page.append(
  el('div', { class: 'page-head' }, [el('h2', { text: t('所有网站', 'All sites') }), el('div', { class: 'page-tools' }, [picker.node, periodBar(load)])]),
  periodNote,
  note.node,
  kpiBox,
  el('div', { class: 'grid grid-chart' }, [overTime.node, countryCard.node]),
  el('h2', { text: t('网站', 'Sites') }),
  sitesBox,
  ipCard.node,
);

// The sparkline goes into `slot` later, when the per-site series arrives.
function siteCard(key, row, slot) {
  const views = Number(row?.pageviews) || 0;
  return el('a', { class: `site-card${views ? '' : ' quiet'}`, href: siteLink(key) }, [
    el('span', { class: 'host', text: siteName(key) }),
    el('span', { class: 'big' }, [fmt(views), el('small', { text: t('次浏览', 'page views') })]),
    el('span', { class: 'meta', text: t(`${fmt(row?.visitors)} 位访客 · ${fmt(row?.ips)} 个 IP`, `${fmt(row?.visitors)} visitors · ${fmt(row?.ips)} IPs`) }),
    slot,
    el('span', { class: 'meta', text: row?.last_visit ? t(`最近访问：${formatTime(row.last_visit)}`, `Last visit ${formatTime(row.last_visit)}`) : t('此时段内没有访问', 'No visits in this period') }),
  ]);
}

const overview = (name) => part('/api/overview', name, scope());

const loadKpis = widget(kpiBox, () => overview('summary'), ({ filters, rows }) => {
  const total = rows[0] || {};
  periodNote.textContent = t(`时段：${periodText(filters)}。${botsNote()}${updatedNote(filters)}`, `Showing ${periodText(filters)}. ${botsNote()}${updatedNote(filters)}`);
  kpiBox.replaceChildren(kpis([
    [t('访客数', 'Visitors'), fmt(total.visitors), t('去重访客：按 dl_vid cookie 计，没有 cookie 时按 IP 计', 'Distinct visitors: the dl_vid cookie, or the IP when there is no cookie')],
    [t('浏览量', 'Page views'), fmt(total.pageviews), t('HTML 页面加载次数', 'HTML page loads')],
    [t('IP 地址', 'IP addresses'), fmt(total.ips), t('去重 IP 地址数', 'Distinct IP addresses')],
    [t('请求数', 'Requests'), fmt(total.requests), t('全部请求，包括静态资源', 'Everything, including assets')],
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

// Site cards: the totals and the sparklines are two queries run side by side. Cards appear as soon as
// the totals arrive; each card keeps a small spinner where its sparkline goes until the series arrives.
let sitesRun = 0;
const busy = (node, on) => {
  node.classList.toggle('loading', on);
  if (on) node.setAttribute('aria-busy', 'true');
  else node.removeAttribute('aria-busy');
};
async function loadSites() {
  const id = ++sitesRun;
  const fresh = () => id === sitesRun;
  const cards = [...sitesBox.children];
  const spinning = cards.length ? cards : [sitesBox];
  spinning.forEach((node) => busy(node, true));
  const sparks = overview('site_series');
  sparks.catch(() => {});
  const slots = new Map();
  try {
    const { rows } = await overview('sites');
    if (!fresh()) return;
    const bySite = new Map(rows.map((row) => [row.site, row]));
    const order = [...new Set([...rows.map((r) => r.site), ...Object.keys(state.siteHosts)])];
    sitesBox.replaceChildren(...order.map((key) => {
      const slot = el('div', { class: 'spark-slot loading', 'aria-busy': 'true' });
      slots.set(key, slot);
      return siteCard(key, bySite.get(key), slot);
    }));
  } catch (error) {
    if (fresh()) handleError(error);
  } finally {
    if (fresh()) spinning.forEach((node) => busy(node, false));
  }
  if (!fresh() || !slots.size) return;
  try {
    const { filters, rows } = await sparks;
    if (!fresh()) return;
    const keys = buckets(filters);
    for (const [key, slot] of slots) {
      slot.replaceChildren(sparkline(series(keys, rows.filter((r) => r.site === key), 'pageviews', (r) => bucketOf(r.bucket, filters.unit))));
    }
  } catch (error) {
    if (fresh()) handleError(error);
  } finally {
    if (fresh()) slots.forEach((slot) => busy(slot, false));
  }
}

// Every widget loads on its own and shows its data as soon as it arrives.
function load() {
  setStatus('');
  note.update();
  picker.load();
  loadKpis();
  loadChart();
  loadSites();
  countries.load();
  if (!state.public) ips.load();
}

start(load, { publicView: true });
