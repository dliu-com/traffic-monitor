import {
  $, api, ago, bucketOf, buckets, card, chart, dataTable, describeUA, el, fmt, formatTime, handleError, ipLink,
  isBot, kpis, period, periodBar, periodText, series, setStatus, siteLink, siteName, sparkline, start, state,
} from './dash.js';

const page = $('page');
const periodNote = el('p', { class: 'period-note' });
const kpiBox = el('div');
const overTime = card('Visits over time');
const sitesBox = el('div', { class: 'site-cards' });
const ipCard = card('Latest IP addresses', { subtitle: 'people only · click an IP to see everything it did' });
const ips = dataTable({
  limit: 15,
  placeholder: 'Find IP, site, browser…',
  empty: 'No visitors in this period',
  columns: [
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Last seen', value: (r) => ago(r.last_seen), title: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: 'Sites', value: (r) => (r.sites || '').split(',').filter(Boolean).map(siteName).join(', ') },
    { label: 'Page views', value: (r) => fmt(r.pageviews), cls: 'num' },
    { label: 'Requests', value: (r) => fmt(r.requests), cls: 'num' },
    { label: 'Browser', value: (r) => describeUA(r.last_ua), title: (r) => r.last_ua, cls: 'muted' },
    { label: 'First seen', value: (r) => formatTime(r.first_seen), cls: 'nowrap muted' },
  ],
});
ipCard.head.append(ips.search);
ipCard.body.append(ips.node);

page.append(
  el('div', { class: 'page-head' }, [el('h2', { text: 'All sites' }), periodBar(load)]),
  periodNote,
  kpiBox,
  overTime.node,
  el('h2', { text: 'Sites' }),
  sitesBox,
  ipCard.node,
);

function siteCard(key, row, sparkValues) {
  const views = Number(row?.pageviews) || 0;
  const link = el('a', { class: `site-card${views ? '' : ' quiet'}`, href: siteLink(key) }, [
    el('span', { class: 'host', text: siteName(key) }),
    el('span', { class: 'big' }, [fmt(views), el('small', { text: 'page views' })]),
    el('span', { class: 'meta', text: `${fmt(row?.visitors)} visitors · ${fmt(row?.ips)} IPs` }),
    sparkline(sparkValues),
    el('span', { class: 'meta', text: row?.last_visit ? `Last visit ${ago(row.last_visit)}` : 'No visits in this period', title: formatTime(row?.last_visit) || null }),
  ]);
  return link;
}

async function load() {
  setStatus('Loading…');
  try {
    const data = await api(`/api/overview?${new URLSearchParams({ site: 'all', ...period() })}`);
    const { filters } = data;
    const total = data.summary[0] || {};
    periodNote.textContent = `Showing ${periodText(filters)} (UTC days). Bots and crawlers are left out of visitors and page views.`;
    kpiBox.replaceChildren(kpis([
      ['Visitors', fmt(total.visitors), 'Distinct people: the dl_vid cookie, or the IP when there is no cookie'],
      ['Page views', fmt(total.pageviews), 'HTML page loads by people'],
      ['IP addresses', fmt(total.human_ips), 'Distinct IPs used by people (not bots)'],
      ['Requests', fmt(total.requests), 'Everything, including assets and bots'],
    ]));

    const keys = buckets(filters);
    overTime.body.replaceChildren(chart(keys, {
      hourly: filters.hourly,
      bars: series(keys, data.timeseries, 'pageviews'),
      line: series(keys, data.timeseries, 'visitors'),
      barLabel: 'Page views',
      lineLabel: 'Visitors',
    }));

    const bySite = new Map(data.sites.map((row) => [row.site, row]));
    const order = [...new Set([...data.sites.map((r) => r.site), ...Object.keys(state.siteHosts)])];
    sitesBox.replaceChildren(...order.map((key) => siteCard(key, bySite.get(key),
      series(keys, data.site_series.filter((r) => r.site === key), 'pageviews', (r) => bucketOf(r.bucket, filters.hourly)))));

    ips.set(data.ips.filter((row) => !isBot(row)));
    setStatus('');
  } catch (error) {
    handleError(error);
  }
}

start(load);
