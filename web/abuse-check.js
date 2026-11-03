// The AbuseIPDB check page (signed in only): how the daily lookups used the free allowance, and what they found.
import { $, botCheck, card, el, fmt, formatTime, ipLink, kpis, setStatus, staticTable, start, widget } from './dash.js';
import { t, translateError } from './i18n.js';

const page = $('page');
const DATA_CENTER = 'Data Center/Web Hosting/Transit';
const api = async (part) => {
  const response = await fetch(`/api/abuse?part=${part}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (response.status === 401) throw Object.assign(new Error('signed out'), { signedOut: true });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(translateError(body.error || `Request failed (${response.status})`));
  return body;
};
const yes = (value) => value === true || value === 'true';

const usageBox = el('div', { class: 'kpi-box' });
const lastRun = el('p', { class: 'period-note' });

const runsCard = card(t('每日查询', 'Lookups per day'), { subtitle: t('最近 30 天', 'last 30 days') });
const runs = staticTable({
  empty: t('尚无运行记录', 'No runs yet'),
  columns: [
    { label: t('日期（UTC）', 'Day (UTC)'), value: (r) => r.day, cls: 'nowrap' },
    { label: t('运行次数', 'Runs'), value: (r) => fmt(r.runs), cls: 'dl-num' },
    { label: t('查询数', 'Lookups'), value: (r) => fmt(r.looked_up), cls: 'dl-num' },
    { label: t('占 1,000 的比例', 'Of 1,000'), value: (r) => `${Math.round((r.looked_up / 1000) * 100)}%`, cls: 'dl-num' },
    { label: t('达到上限', 'Limit reached'), value: (r) => (r.limit_hit ? t('是', 'yes') : ''), cls: 'nowrap' },
    { label: t('失败', 'Failures'), value: (r) => (r.failures ? fmt(r.failures) : ''), cls: 'dl-num' },
  ],
});
runsCard.body.append(runs.node);

const daysCard = card(t('每个日志日的 IP', 'IPs per log day'), { subtitle: t('每个 IP 只计一次，计在最近的那一天', 'each IP counts once, on its newest day') });
const days = staticTable({
  empty: t('尚无运行记录', 'No runs yet'),
  columns: [
    { label: t('日志日期（UTC）', 'Log day (UTC)'), value: (r) => r.day, cls: 'nowrap' },
    { label: t('出现的 IP', 'IPs seen'), value: (r) => fmt(r.seen), cls: 'dl-num' },
    { label: t('真人', 'People'), value: (r) => fmt(r.people), cls: 'dl-num' },
    { label: t('近期已查', 'Checked recently'), value: (r) => fmt(r.skipped), cls: 'dl-num' },
    { label: t('已查询', 'Looked up'), value: (r) => fmt(r.looked_up), cls: 'dl-num' },
    { label: t('恶意', 'Abusive'), value: (r) => fmt(r.abusive), cls: 'dl-num' },
    { label: t('待查询', 'Waiting'), value: (r) => (r.dropped == null ? fmt(r.left) : ''), cls: 'dl-num' },
    { label: t('视为安全而放弃', 'Dropped as safe'), value: (r) => (r.dropped == null ? '' : fmt(r.dropped)), cls: 'dl-num' },
  ],
});
daysCard.body.append(days.node);

const resultBox = el('div', { class: 'kpi-box' });
const scoresCard = card(t('评分', 'Scores'), { subtitle: t('最近 30 天查询过的 IP', 'IPs looked up in the last 30 days') });
const scores = staticTable({
  empty: t('尚无查询', 'No lookups yet'),
  columns: [
    { label: t('滥用评分', 'Abuse score'), value: (r) => r.bucket },
    { label: t('IP 数', 'IPs'), value: (r) => fmt(r.ips), cls: 'dl-num' },
  ],
});
scoresCard.body.append(scores.node);
const usageCard = card(t('使用类型', 'Usage types'));
const usage = staticTable({
  empty: t('尚无查询', 'No lookups yet'),
  columns: [
    { label: t('使用类型', 'Usage type'), value: (r) => r.usage_type },
    { label: t('IP 数', 'IPs'), value: (r) => fmt(r.ips), cls: 'dl-num' },
    { label: t('评分 ≥ 50', 'Score ≥ 50'), value: (r) => fmt(r.high_score), cls: 'dl-num' },
  ],
});
usageCard.body.append(usage.node);

const abusiveCard = card(t('恶意 IP', 'Abusive IPs'), { subtitle: t('评分 50 及以上、Tor 或数据中心；最多 500 个，评分高的在前', 'score 50+, Tor, or a data center; up to 500, highest score first') });
const abusive = staticTable({
  empty: t('未发现', 'None found'),
  columns: [
    { label: t('IP 地址', 'IP address'), value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: t('评分', 'Score'), value: (r) => r.score, cls: 'dl-num' },
    { label: t('举报数', 'Reports'), value: (r) => fmt(r.reports), cls: 'dl-num' },
    { label: t('原因', 'Why'), value: (r) => [Number(r.score) >= 50 ? t('评分', 'score') : '', yes(r.is_tor) ? 'Tor' : '', r.usage_type === DATA_CENTER ? t('数据中心', 'data center') : ''].filter(Boolean).join(t('、', ', ')) },
    { label: t('使用类型', 'Usage type'), value: (r) => r.usage_type || '', cls: 'dl-muted' },
    { label: t('网络', 'Network'), value: (r) => r.isp || '', cls: 'dl-muted' },
    { label: t('查询时间', 'Checked'), value: (r) => formatTime(r.checked), cls: 'nowrap dl-muted' },
  ],
});
abusiveCard.body.append(abusive.node);

page.append(
  el('p', { class: 'crumbs' }, [el('a', { href: '/bots', text: t('机器人', 'Bots') }), t(' › AbuseIPDB 检查', ' › AbuseIPDB check')]),
  el('div', { class: 'page-head' }, [el('h2', { text: t('AbuseIPDB 检查', 'AbuseIPDB check') }), el('div', { class: 'page-tools' }, [botCheck(load)])]),
  el('p', { class: 'period-note' }, [
    t('机器人检查每 6 小时运行一次，会在 AbuseIPDB 上查询看起来像真人的 IP（免费套餐：每天 1,000 次查询，由当天各次运行共用）。每个 IP 只查询一次，30 天后才会再次查询。3 天内未查询到的 IP 会被放弃，按真人计。',
      'The bot check, every 6 hours, looks up IPs that look like people on AbuseIPDB (free plan: 1,000 lookups a day, shared by the day\'s runs). An IP is looked up once, and again only after 30 days. IPs not looked up within 3 days are dropped and count as people. '),
    el('a', { href: '/docs#bot-detection', text: t('机器人识别方法', 'How bots are detected') }), t('。', '.'),
  ]),
  usageBox,
  lastRun,
  el('div', { class: 'grid grid-pair' }, [runsCard.node, daysCard.node]),
  el('h2', { text: t('结果', 'Results') }),
  resultBox,
  el('div', { class: 'grid grid-pair' }, [scoresCard.node, usageCard.node]),
  abusiveCard.node,
);

const loadRuns = widget(usageBox, () => api('runs'), (data) => {
  usageBox.replaceChildren(kpis([
    [t('今日查询', 'Lookups today'), `${fmt(data.today.looked_up)} / ${fmt(data.limit)}`, t('今天（UTC）已用的 AbuseIPDB 查询次数', 'AbuseIPDB lookups used today (UTC)')],
    [t('今日剩余', 'Left today'), data.today.remaining == null ? '—' : fmt(data.today.remaining), t('今天最近一次运行后 AbuseIPDB 报告的剩余次数', 'What AbuseIPDB said was left after the last run today')],
    [t('待查询 IP', 'IPs waiting'), fmt(data.waiting), t('最近 3 天内仍待查询的 IP；下一次运行会优先处理', 'IPs from the last 3 days still to look up; the next run takes them first')],
    [t('下次运行', 'Next run'), formatTime(data.next_run), t('机器人检查在 UTC 时间 00:30、06:30、12:30 和 18:30 运行', 'The bot check runs at 00:30, 06:30, 12:30 and 18:30 UTC')],
  ]));
  const last = data.last_run;
  lastRun.textContent = last
    ? t(
      `最近一次运行：${formatTime(last.finished)}（${last.trigger === 'dashboard' ? '立即检查机器人' : '定时'}），覆盖 ${last.from} 至 ${last.to}：查询 ${fmt(last.looked_up)} 次${last.stopped ? `，已停止：${last.stopped}` : ''}。`,
      `Last run ${formatTime(last.finished)} (${last.trigger === 'dashboard' ? 'Check bots now' : 'daily'}), covering ${last.from} to ${last.to}: ${fmt(last.looked_up)} lookups${last.stopped ? `, stopped: ${last.stopped}` : ''}.`,
    )
    : t('尚无运行记录。', 'No runs recorded yet.');
  runs.set(data.runs);
  days.set(data.days);
});
const loadSummary = widget(resultBox, () => api('summary'), ({ rows }) => {
  const r = rows[0] || {};
  resultBox.replaceChildren(kpis([
    [t('已查询 IP', 'IPs looked up'), fmt(r.ips), t('最近 30 天查询过的不同 IP 数', 'Distinct IPs looked up in the last 30 days')],
    [t('恶意', 'Abusive'), fmt(r.abusive), t('评分 50 及以上、Tor 或数据中心', 'Score 50+, Tor, or a data center')],
    [t('评分 ≥ 50', 'Score ≥ 50'), fmt(r.high_score), t('被举报次数多到足以判定为恶意', 'Reported often enough to count as abusive')],
    [t('Tor 出口', 'Tor exits'), fmt(r.tor), t('Tor 出口节点', 'Tor exit nodes')],
    [t('数据中心', 'Data centers'), fmt(r.data_center), t('使用类型为 Data Center/Web Hosting/Transit（部分知名网络除外）', 'Usage type: Data Center/Web Hosting/Transit (some well-known networks are excused)')],
  ]));
});
const loadScores = widget(scoresCard.node, () => api('scores'), ({ rows }) => scores.set(rows));
const loadUsage = widget(usageCard.node, () => api('usage'), ({ rows }) => usage.set(rows));
const loadAbusive = widget(abusiveCard.node, () => api('abusive'), ({ rows }) => abusive.set(rows));

function load() {
  setStatus('');
  loadRuns();
  loadSummary();
  loadScores();
  loadUsage();
  loadAbusive();
}

start(load);
