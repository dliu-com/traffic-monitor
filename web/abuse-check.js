// The AbuseIPDB check page (signed in only): how the daily lookups used the free allowance, and what they found.
import { $, botCheck, card, el, fmt, formatTime, ipLink, kpis, setStatus, staticTable, start, widget } from './dash.js';

const page = $('page');
const DATA_CENTER = 'Data Center/Web Hosting/Transit';
const api = async (part) => {
  const response = await fetch(`/api/abuse?part=${part}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (response.status === 401) throw Object.assign(new Error('signed out'), { signedOut: true });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
};
const yes = (value) => value === true || value === 'true';

const usageBox = el('div', { class: 'kpi-box' });
const lastRun = el('p', { class: 'period-note' });

const runsCard = card('Lookups per day', { subtitle: 'last 30 days' });
const runs = staticTable({
  empty: 'No runs yet',
  columns: [
    { label: 'Day (UTC)', value: (r) => r.day, cls: 'nowrap' },
    { label: 'Runs', value: (r) => fmt(r.runs), cls: 'num' },
    { label: 'Lookups', value: (r) => fmt(r.looked_up), cls: 'num' },
    { label: 'Of 1,000', value: (r) => `${Math.round((r.looked_up / 1000) * 100)}%`, cls: 'num' },
    { label: 'Limit reached', value: (r) => (r.limit_hit ? 'yes' : ''), cls: 'nowrap' },
    { label: 'Failures', value: (r) => (r.failures ? fmt(r.failures) : ''), cls: 'num' },
  ],
});
runsCard.body.append(runs.node);

const daysCard = card('IPs per log day', { subtitle: 'each IP counts once, on its newest day' });
const days = staticTable({
  empty: 'No runs yet',
  columns: [
    { label: 'Log day (UTC)', value: (r) => r.day, cls: 'nowrap' },
    { label: 'IPs seen', value: (r) => fmt(r.seen), cls: 'num' },
    { label: 'People', value: (r) => fmt(r.people), cls: 'num' },
    { label: 'Checked recently', value: (r) => fmt(r.skipped), cls: 'num' },
    { label: 'Looked up', value: (r) => fmt(r.looked_up), cls: 'num' },
    { label: 'Abusive', value: (r) => fmt(r.abusive), cls: 'num' },
    { label: 'Waiting', value: (r) => (r.dropped == null ? fmt(r.left) : ''), cls: 'num' },
    { label: 'Dropped as safe', value: (r) => (r.dropped == null ? '' : fmt(r.dropped)), cls: 'num' },
  ],
});
daysCard.body.append(days.node);

const resultBox = el('div', { class: 'kpi-box' });
const scoresCard = card('Scores', { subtitle: 'IPs looked up in the last 30 days' });
const scores = staticTable({
  empty: 'No lookups yet',
  columns: [
    { label: 'Abuse score', value: (r) => r.bucket },
    { label: 'IPs', value: (r) => fmt(r.ips), cls: 'num' },
  ],
});
scoresCard.body.append(scores.node);
const usageCard = card('Usage types');
const usage = staticTable({
  empty: 'No lookups yet',
  columns: [
    { label: 'Usage type', value: (r) => r.usage_type },
    { label: 'IPs', value: (r) => fmt(r.ips), cls: 'num' },
    { label: 'Score ≥ 50', value: (r) => fmt(r.high_score), cls: 'num' },
  ],
});
usageCard.body.append(usage.node);

const abusiveCard = card('Abusive IPs', { subtitle: 'score 50+, Tor, or a data center; up to 500, highest score first' });
const abusive = staticTable({
  empty: 'None found',
  columns: [
    { label: 'IP address', value: (r) => r.ip, href: (r) => ipLink(r.ip), cls: 'nowrap' },
    { label: 'Score', value: (r) => r.score, cls: 'num' },
    { label: 'Reports', value: (r) => fmt(r.reports), cls: 'num' },
    { label: 'Why', value: (r) => [Number(r.score) >= 50 ? 'score' : '', yes(r.is_tor) ? 'Tor' : '', r.usage_type === DATA_CENTER ? 'data center' : ''].filter(Boolean).join(', ') },
    { label: 'Usage type', value: (r) => r.usage_type || '', cls: 'muted' },
    { label: 'Network', value: (r) => r.isp || '', cls: 'muted' },
    { label: 'Checked', value: (r) => formatTime(r.checked), cls: 'nowrap muted' },
  ],
});
abusiveCard.body.append(abusive.node);

page.append(
  el('p', { class: 'crumbs' }, [el('a', { href: '/bots', text: 'Bots' }), ' › AbuseIPDB check']),
  el('div', { class: 'page-head' }, [el('h2', { text: 'AbuseIPDB check' }), el('div', { class: 'page-tools' }, [botCheck(load)])]),
  el('p', { class: 'period-note' }, [
    'The daily bot check looks up IPs that look like people on AbuseIPDB (free plan: 1,000 lookups a day). An IP is looked up again after 30 days. IPs not looked up within 3 days are dropped and count as people. ',
    el('a', { href: '/detect-bot', text: 'How bots are detected' }), '.',
  ]),
  usageBox,
  lastRun,
  el('div', { class: 'grid grid-pair' }, [runsCard.node, daysCard.node]),
  el('h2', { text: 'Results' }),
  resultBox,
  el('div', { class: 'grid grid-pair' }, [scoresCard.node, usageCard.node]),
  abusiveCard.node,
);

const loadRuns = widget(usageBox, () => api('runs'), (data) => {
  usageBox.replaceChildren(kpis([
    ['Lookups today', `${fmt(data.today.looked_up)} / ${fmt(data.limit)}`, 'AbuseIPDB lookups used today (UTC)'],
    ['Left today', data.today.remaining == null ? '—' : fmt(data.today.remaining), 'What AbuseIPDB said was left after the last run today'],
    ['IPs waiting', fmt(data.waiting), 'IPs from the last 3 days still to look up; the next run takes them first'],
    ['Next run', formatTime(data.next_run), 'The daily bot check (00:30 UTC)'],
  ]));
  const last = data.last_run;
  lastRun.textContent = last
    ? `Last run ${formatTime(last.finished)} (${last.trigger === 'dashboard' ? 'Check bots now' : 'daily'}), covering ${last.from} to ${last.to}: ${fmt(last.looked_up)} lookups${last.stopped ? `, stopped: ${last.stopped}` : ''}.`
    : 'No runs recorded yet.';
  runs.set(data.runs);
  days.set(data.days);
});
const loadSummary = widget(resultBox, () => api('summary'), ({ rows }) => {
  const r = rows[0] || {};
  resultBox.replaceChildren(kpis([
    ['IPs looked up', fmt(r.ips), 'Distinct IPs looked up in the last 30 days'],
    ['Abusive', fmt(r.abusive), 'Score 50+, Tor, or a data center'],
    ['Score ≥ 50', fmt(r.high_score), 'Reported often enough to count as abusive'],
    ['Tor exits', fmt(r.tor), 'Tor exit nodes'],
    ['Data centers', fmt(r.data_center), 'Usage type: Data Center/Web Hosting/Transit (some well-known networks are excused)'],
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
