import {
  $, botReasonText, card, countryLabel, countryName, countryShort, describeBrowser, describeDevice, el, facts, fmt,
  formatTime, hostingName, IP_PATTERN, ipLink, isBot, kpis, pagedTable, pageLink, part, period, periodBar, periodText,
  setStatus, siteLink, siteName, start, staticTable, uaColumns, uaTitle, visitorLink, widget,
} from './dash.js';
import { t } from './i18n.js';

const page = $('page');
const ip = new URLSearchParams(location.search).get('ip') || '';

const home = el('a', { text: t('所有网站', 'All sites') });
const title = el('h2', {}, [ip]);
const periodNote = el('p', { class: 'period-note' });
const kpiBox = el('div', { class: 'kpi-box' });
const aboutCard = card(t('关于此 IP', 'About this IP'));
// The summary fills the title, KPIs and "About this IP"; one spinner covers the KPIs and the About card.
const summaryBox = el('div', {}, [kpiBox, aboutCard.node]);

const sitesCard = card(t('访问过的网站', 'Sites visited'));
const sites = staticTable({
  empty: t('此 IP 在此时段内没有请求', 'No requests from this IP in this period'),
  columns: [
    { label: t('网站', 'Site'), value: (r) => siteName(r.site), href: (r) => siteLink(r.site) },
    { label: t('浏览量', 'Page views'), value: (r) => fmt(r.pageviews), cls: 'dl-num' },
    { label: t('请求', 'Requests'), value: (r) => fmt(r.requests), cls: 'dl-num' },
    { label: t('首次出现', 'First seen'), value: (r) => formatTime(r.first_seen), cls: 'nowrap dl-muted' },
    { label: t('最后出现', 'Last seen'), value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
  ],
});
sitesCard.body.append(sites.node);

const relatedCard = card(t('同一访客的其他 IP', 'Same visitor on other IPs'), { subtitle: t('同一 dl_vid 访客 ID 使用过的 IP', 'IPs used by the same dl_vid visitor ID') });
const scope = () => ({ site: 'all', ip, ...period() });
const related = pagedTable({
  list: 'related',
  params: scope,
  pageSize: 10,
  placeholder: t('搜索 IP、网站、城市、User-Agent…', 'Search IP, site, city, user agent…'),
  empty: t('无——此 Cookie 只在此 IP 上出现过', 'None — this cookie was only seen on this IP'),
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
relatedCard.head.append(related.search);
relatedCard.body.append(related.node);

const cookieCard = card(t('访客 ID', 'Visitor IDs'), { subtitle: t('从此 IP 使用过的 dl_vid ID', 'dl_vid IDs used from this IP') });
const cookies = pagedTable({
  list: 'cookies',
  params: scope,
  pageSize: 10,
  placeholder: t('搜索 Cookie ID、网站…', 'Search cookie ID, site…'),
  empty: t('此 IP 上没有出现过 dl_vid 访客 ID', 'No dl_vid visitor ID was seen from this IP'),
  columns: [
    { label: t('访客 ID', 'Visitor ID'), value: (r) => r.visitor_id, href: (r) => visitorLink(r.visitor_id), cls: 'nowrap' },
    { label: t('最后出现', 'Last seen'), value: (r) => formatTime(r.last_seen), cls: 'nowrap' },
    { label: t('网站', 'Sites'), value: (r) => (r.sites || '').split(',').filter(Boolean).map(siteName).join(', ') },
    { label: t('浏览量', 'Page views'), value: (r) => fmt(r.pageviews), cls: 'dl-num' },
    { label: t('请求', 'Requests'), value: (r) => fmt(r.requests), cls: 'dl-num' },
  ],
});
cookieCard.head.append(cookies.search);
cookieCard.body.append(cookies.node);

const logCard = card(t('请求', 'Requests'), { subtitle: t('最新的在前', 'newest first') });
const log = pagedTable({
  list: 'requests',
  params: scope,
  pageSize: 50,
  placeholder: t('搜索路径、网站、状态码…', 'Search path, site, status…'),
  empty: t('没有请求', 'No requests'),
  rowClass: (r) => (isBot(r) ? 'bot' : null),
  columns: [
    { label: t('时间', 'Time'), value: (r) => formatTime(r.time), cls: 'nowrap' },
    { label: t('网站', 'Site'), value: (r) => siteName(r.site), cls: 'nowrap' },
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
  el('p', { class: 'crumbs' }, [home, t(' › IP 地址', ' › IP address')]),
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
  periodNote.textContent = t(`显示 ${periodText(filters)}，涵盖所有网站，含机器人。`, `Showing ${periodText(filters)} across all sites, bots included.`);
  title.replaceChildren(ip, seen ? el('span', { class: `tag${isBot(s) ? ' bot' : ''}`, text: isBot(s) ? t('机器人', 'Bot') : t('真人', 'Person') }) : null);
  kpiBox.replaceChildren(kpis([
    [t('浏览量', 'Page views'), fmt(s.pageviews), t('HTML 页面加载次数', 'HTML page loads')],
    [t('请求', 'Requests'), fmt(s.requests), t('全部请求，包括静态资源', 'Everything, including assets')],
    [t('网站', 'Sites'), fmt(s.sites)],
    [t('活跃天数', 'Days active'), fmt(s.days), t('至少有一次请求的天数（UTC）', 'UTC days with at least one request')],
  ]));
  const abuseLink = el('a', { href: `https://www.abuseipdb.com/check/${encodeURIComponent(ip)}`, target: '_blank', rel: 'noopener noreferrer', text: t('AbuseIPDB 上的滥用举报 ↗', 'Abuse reports on AbuseIPDB ↗') });
  const lookup = el('a', { href: `https://ipinfo.io/${encodeURIComponent(ip)}`, target: '_blank', rel: 'noopener noreferrer', text: t('在 ipinfo.io 查询城市和网络名称 ↗', 'Look up city and network name on ipinfo.io ↗') });
  const countries = Number(s.countries) || 0;
  aboutCard.body.replaceChildren(
    facts([
      [t('国家/地区', 'Country'), s.country ? `${countryLabel(s.country)}${countries > 1 ? t(`（此时段内共 ${countries} 个国家/地区）`, ` (${countries} countries in this period)`) : ''}` : (seen ? t('未记录', 'Not recorded') : ''),
        s.country ? null : t('国家/地区由 CloudFront 记录，仅限开始记录国家/地区之后的请求', 'Country is recorded by CloudFront for requests logged after country logging started')],
      [t('城市', 'City'), s.city || (seen ? t('未记录', 'Not recorded') : ''),
        s.city ? t('CloudFront 判定此 IP 最近所在的城市（大致）；“(DB-IP)”表示 CloudFront 未提供，城市来自 DB-IP 的数据库', 'Latest city CloudFront placed this IP in (approximate); “(DB-IP)” means CloudFront gave none and it comes from DB-IP’s database')
          : t('CloudFront 和 DB-IP 都未能确定此 IP 所在的城市（或 DB-IP 将其定位到另一个国家/地区）', 'Neither CloudFront nor DB-IP placed this IP in a city (or DB-IP placed it in another country)')],
      [t('网络', 'Network'), s.asn ? `AS${s.asn}${hostingName(s.asn) ? t(` · ${hostingName(s.asn)}（托管网络）`, ` · ${hostingName(s.asn)} (hosting network)`) : ''}` : (seen ? t('未记录', 'Not recorded') : ''),
        t('此 IP 所属的自治系统（ISP 或托管服务商）', 'The autonomous system (ISP or hosting provider) the IP belongs to')],
      [t('判定为机器人', 'Counted as a bot'), seen ? (botReasonText(s.bot_reasons) || t('否', 'No')) : '',
        t('爬虫 User-Agent 立即计入；其他原因来自每 6 小时一次的机器人检查，因此最新的请求可能尚未判定', 'Crawler user agents count at once; the other reasons come from the bot check every 6 hours, so the newest requests may not be judged yet')],
      [t('首次出现', 'First seen'), seen ? formatTime(s.first_seen) : ''],
      [t('最后出现', 'Last seen'), seen ? formatTime(s.last_seen) : ''],
      [t('最新浏览器', 'Latest browser'), describeBrowser(s.last_ua), s.last_ua],
      [t('最新设备', 'Latest device'), describeDevice(s.last_ua, s.last_hints), uaTitle(s.last_ua, s.last_hints)],
      [t('不同浏览器数', 'Different browsers'), seen ? fmt(s.user_agents) : ''],
      [t('访客 ID（dl_vid）', 'Visitor IDs (dl_vid)'), seen ? fmt(s.cookies) : ''],
      [t('错误', 'Errors'), seen ? fmt(s.errors) : ''],
    ]),
    reputationFacts,
    el('p', {}, [lookup, ' · ', abuseLink]),
  );
  setStatus(seen ? '' : t('此 IP 在此时段内没有请求，请尝试更长的时段。', 'This IP made no requests in this period. Try a longer period.'));
});

// The latest AbuseIPDB result saved by the bot check (only IPs that otherwise looked like people are checked).
const reputationFacts = el('div');
const loadReputation = widget(reputationFacts, () => ipPart('reputation'), ({ rows }) => {
  const r = rows[0];
  reputationFacts.replaceChildren(facts([
    ['AbuseIPDB', r ? t(`滥用置信度 ${fmt(r.score)}% · ${fmt(r.reports)} 次举报${r.is_tor === 'true' ? ' · Tor 出口节点' : ''}`,
      `${fmt(r.score)}% abuse confidence · ${fmt(r.reports)} report${Number(r.reports) === 1 ? '' : 's'}${r.is_tor === 'true' ? ' · Tor exit' : ''}`) : t('未检查', 'Not checked'),
      r ? null : t('机器人检查会查询其他方面看起来像真人的 IP', 'The bot check looks up IPs that otherwise look like people')],
    ...(r ? [[t('用途类型', 'Usage type'), r.usage_type || '—'], ['ISP', r.isp || '—'], [t('检查时间', 'Checked'), formatTime(r.checked)]] : []),
  ]));
});

const loadSites = widget(sitesCard.node, () => ipPart('sites'), ({ rows }) => sites.set(rows));

// Every widget loads on its own and shows its data as soon as it arrives.
function load() {
  home.setAttribute('href', pageLink('/'));
  setStatus('');
  loadSummary();
  loadSites();
  loadReputation();
  for (const table of [cookies, related, log]) table.load();
}

start(async () => {
  if (!IP_PATTERN.test(ip)) {
    location.replace(pageLink('/'));
    return;
  }
  document.title = t(`${ip} · 流量`, `${ip} · Traffic`);
  load();
});
