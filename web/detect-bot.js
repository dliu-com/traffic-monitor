import { flow, tiers, stats, table, more, callout } from './diagram.js';

const root = document.getElementById('detect-bot');

function add(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  root.append(node);
  return node;
}

function list(items) {
  const ul = document.createElement('ul');
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    ul.append(li);
  }
  root.append(ul);
}

root.append(stats([
  ['00:30 UTC', 'daily check of the last 3 days', 'clock'],
  ['5 rules', 'tried in a fixed order', 'filter'],
  ['900', 'AbuseIPDB lookups a day at most', 'shield'],
  ['0', 'browsers judged by their name', 'browser'],
]));

add('h2', 'The rules');
add('p', 'A request is a bot if its user agent gives it away. Every other rule is judged once a day for each IP address and day (UTC), across all sites together, and the first rule that matches is the reason shown on the dashboard.');
root.append(flow({
  title: 'Checks, in order',
  numbered: true,
  steps: [
    { icon: 'bot', title: 'Crawler or script', text: 'The user agent is missing or names a crawler, HTTP library or tool (bot, spider, curl, python, Go…). Checked on every request, straight away' },
    { icon: 'cloudfront', title: 'Hosting network', text: 'The IP belongs to a cloud, hosting or VPN network (about 950 ASNs)' },
    { icon: 'eye', title: 'Scanner', text: 'It asked for paths only attackers look for: /.env, /.git, wp-login, phpMyAdmin, .php files, backups…' },
    { icon: 'shield', title: 'Reported abuse', text: 'AbuseIPDB gives it 50% or more abuse confidence, lists it as a Tor exit, or as a data centre' },
    { icon: 'code', title: 'Never loads a page', text: 'All day it fetched no script, stylesheet or font and never sent back the dl_vid cookie' },
    { icon: 'users', title: 'Person', text: 'Nothing matched', tone: 'private' },
  ],
  note: 'Pictures do not count as loading a page: link previews in chat apps fetch only the page and its preview image.',
}));

root.append(table(['Reason', 'Shown as', 'Why it works'], [
  ['agent', 'crawler or script (user agent)', 'Honest crawlers and tools say what they are. A browser always sends a user agent'],
  ['hosting', 'cloud or hosting network', 'People browse from home, mobile and office networks, not from servers. Cloudflare WARP, iCloud Private Relay, Fastly and Apple are never counted, as they carry real people'],
  ['probe', 'scanned for weak spots', 'None of the dliu.com sites use PHP, WordPress or dotfiles, so nobody has a reason to ask for them'],
  ['abuse', 'reported on AbuseIPDB', 'Other site owners report IPs that attacked them; AbuseIPDB also knows which IPs are data centres and Tor exits'],
  ['headless', 'never loaded scripts, styles or the cookie', 'A browser that shows a page also loads its scripts and styles, or comes back with the cookie. Scripts that fake a browser user agent usually fetch only the HTML'],
]));

root.append(callout('browser', 'The browser name is never used against a visitor. WeChat, QQ Browser, 360, UC, Quark, Huawei, Sogou and other browsers popular in China, as well as in-app browsers everywhere, are treated exactly like Chrome or Safari: only what they do counts.'));

add('h2', 'When it runs');
root.append(tiers({
  title: 'Daily bot check',
  rows: [
    {
      label: 'Trigger', badge: 'Daily', tone: 'edge',
      nodes: [
        { icon: 'clock', title: 'Schedule', text: 'EventBridge at 00:30 UTC, retried twice on error' },
        { icon: 'user', title: 'Check bots now', text: 'Button on the Bots page; also checks today so far' },
      ],
    },
    {
      label: 'Bot check Lambda', badge: 'Up to 15 min', tone: 'app', link: 'starts',
      nodes: [
        { icon: 'athena', title: 'One Athena query', text: 'Per day and IP: requests, browser requests, network, scanned paths, page loads, last AbuseIPDB result' },
        { icon: 'shield', title: 'AbuseIPDB', text: 'Looks up IPs that still look like people' },
        { icon: 'filter', title: 'Rules', text: 'Picks the first matching reason for each IP and day' },
      ],
    },
    {
      label: 'Log bucket', badge: 'Private', tone: 'private', link: 'writes',
      nodes: [
        { icon: 's3', title: 'bots/dt=<day>/', text: 'One file per day listing its bots and why; replaced on every run' },
        { icon: 's3', title: 'reputation/dt=<day>/', text: 'AbuseIPDB results, kept 180 days' },
      ],
    },
    {
      label: 'Dashboard', badge: 'Sign-in', tone: 'app', link: 'joined by day and IP',
      nodes: [
        { icon: 'chart', title: 'Every widget', text: 'Leaves bots out unless Include bots is ticked' },
        { icon: 'page', title: 'IP page', text: 'Shows why an IP counts as a bot and its AbuseIPDB result' },
      ],
    },
  ],
  note: 'Each run re-judges the last 3 days, so a late AbuseIPDB result or a newly listed hosting network still corrects them. After that the daily log merge deletes the bots\' requests for good.',
}));
list([
  'Today\'s traffic counts as people until a check has covered it, except requests with a crawler user agent. A delay of up to a day is expected.',
  'Check bots now, on the Bots page, runs the same check over the last 3 days plus today. It takes about a minute; the page reloads when it finishes. Only one check runs at a time.',
  'The dashboards leave bots out. The Bots page (signed in) shows their requests, IPs and user agents for any period; the AbuseIPDB check page shows how the daily lookups were used.',
  'At 01:30 UTC the log merge turns each day the check has finished with (4 days ago) into one file per site in a folder per month (archive/month=YYYY-MM/) and deletes the bots\' requests for good, so bot records exist only for the last 3 days plus today.',
  'Verdicts are per day: an IP that was a bot yesterday is judged again today, because home and mobile IPs change hands.',
]);

add('h2', 'AbuseIPDB and its daily limit');
add('p', 'The free AbuseIPDB plan allows 1,000 lookups a day, reset at midnight UTC. The check spends them carefully:');
root.append(table(['Rule', 'Effect'], [
  ['Only possible people', 'IPs already caught by another rule, or that never used a browser user agent, are not looked up'],
  ['Once per run', 'Each IP is looked up at most once per run, however many days or sites it visited'],
  ['Saved for 30 days', 'An IP is looked up again only after 30 days; results are kept for 180 days'],
  ['Newest and busiest first', 'IPs from the latest day go first, the busiest ones first within a day'],
  ['At most 900 a run', 'Leaves room for a second run on the same day, such as Check bots now'],
  ['Stops at the limit', 'When AbuseIPDB answers 429 or says no lookups are left, the run stops looking up, saves what it has and flags with the results it already has'],
  ['Catches up the next day', 'IPs that were not looked up go first in the next run while they are within the 3-day window; after that they are dropped and count as people'],
]));
add('p', 'Only the IP address is sent to AbuseIPDB, never the visitor ID, page or user agent. The API key is stored encrypted in SSM Parameter Store. Without a key, the check still runs every other rule.');

add('h2', 'Limits');
list([
  'A bot that runs a real browser, loads every file and comes from a home or mobile network looks like a person.',
  'Several people behind one IP (an office, a school or mobile carrier NAT) share one verdict for the day.',
  'A person who blocks scripts and cookies and visits only once may count as never loading a page.',
  'The hosting list and AbuseIPDB can be wrong; the IP page shows the reason so it can be checked.',
]);

const details = document.createElement('div');
const detailList = (title, items) => {
  const h3 = document.createElement('h3');
  h3.textContent = title;
  const ul = document.createElement('ul');
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    ul.append(li);
  }
  details.append(h3, ul);
};
detailList('Data', [
  'Glue tables bot_ips (ip, reason) and ip_reputation (ip, score, reports, usage_type, isp, domain, is_tor, checked), both newline-delimited JSON partitioned by day with partition projection.',
  'Dashboard queries LEFT JOIN bot_ips on day and IP for the chosen period; the crawler user agent rule is applied in the same query.',
  'Bot verdicts are deleted after a year. The bots\' own requests are deleted by the daily log merge once a day is 4 days old.',
  'Each run writes its AbuseIPDB counts (per log day: seen, people, checked recently, looked up, left, abusive) to abuseipdb/runs/, kept 120 days, for the AbuseIPDB check page.',
  'The hosting list is rebuilt every Monday from two public ASN lists plus a built-in core, and stored in the log bucket.',
  'The run status (running, done or failed, with counts) is kept in bots/status.json; a run that has not finished after 16 minutes is shown as failed.',
]);
detailList('Commands', [
  'make classify-bots DAYS=3 re-checks the last 3 days from the command line (older days have been merged, so re-checking them changes nothing).',
  'make compact-logs merges days now; FROM=YYYY-MM-DD TO=YYYY-MM-DD merges older days once, DRY=1 only reports what it would do, UNJUDGED=1 also merges days from before the bot check (dropping agent bots only).',
  'make set-abuseipdb-key stores the AbuseIPDB key in SSM without echoing it.',
  'The bot check Lambda logs a summary of each run: days, IPs, bots per reason and AbuseIPDB lookups used and left.',
]);
details.append(document.createElement('h3'));
details.lastChild.textContent = 'Further reading';
const links = document.createElement('ul');
for (const [href, text] of [
  ['https://docs.abuseipdb.com/#check-endpoint', 'AbuseIPDB check endpoint'],
  ['https://www.abuseipdb.com/pricing', 'AbuseIPDB plans and daily limits'],
  ['https://github.com/brianhama/bad-asn-list', 'Bad ASN list'],
  ['https://github.com/X4BNet/lists_vpn', 'X4BNet VPN and data centre lists'],
]) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.rel = 'noopener';
  li.append(a);
  links.append(li);
}
details.append(links);
root.append(more('More technical details (text)', details));

const footer = document.createElement('footer');
footer.textContent = 'Source: dliu-com/traffic-monitor (lambda/dashboard/bots.js).';
root.append(footer);
