import { flow, stats, table, callout } from './diagram.js';

const root = document.getElementById('cost');

function add(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  root.append(node);
  return node;
}

const num = (text) => ({ text, className: 'num' });

root.append(stats([
  ['≈ $0.23', 'per month for the whole monitor', 'budget'],
  ['$0', 'per guest page load (pre-computed files)', 'shield'],
  ['≈ $0.005', 'per signed-in dashboard page load', 'athena'],
]));

add('h2', 'Monthly bill');
add('p', 'What the monitor costs with nobody using the dashboard: recording every request to every site, the daily jobs and the files guests read.');
root.append(table(['Part', 'How it is billed', 'Typical month'], [
  ['S3 requests', 'About 11,000 log files a month (about 350 a day); each is written, read, filed and deleted once ($0.005 per 1,000 writes)', num('≈ $0.11')],
  ['Public statistics', 'Three Athena queries a day, at 02:00 UTC, write the 7, 30 and 90-day totals guests see', num('≈ $0.08')],
  ['Bot check Lambda', 'One run a day at 00:30 UTC (about a minute), plus Check bots now, and one Athena query each', num('≈ $0.02')],
  ['Daily log merge', 'At 01:30 UTC merges each site\'s day into one file in a folder per month and deletes bots\' requests', num('≈ $0.01')],
  ['S3 storage, CloudWatch logs, weekly hosting list', 'Gzipped logs of about 25 MB a month, kept for one year; Lambda logs kept one month', num('≈ $0.01')],
  ['CloudFront log delivery (standard logging v2)', '$0.25 per GB of log lines delivered to S3; a few MB a month at this traffic', num('< $0.01')],
  ['Visitor ID function', '$0.10 per million site requests', num('< $0.01')],
  ['Partitioner Lambda', 'One short call per log file', num('$0 (free tier)')],
  ['AbuseIPDB', 'Free plan, up to 1,000 lookups a day', num('$0')],
  ['Dashboard Lambda, CloudFront, Glue, SSM', 'Per request, or free at this size', num('$0')],
  ['Total', 'Before anyone signs in', num('≈ $0.23')],
]));

add('h2', 'Per page load');
add('p', 'Guests read pre-computed files, so a guest visit never starts a query and costs nothing however many there are. Signed-in pages query Athena live; each widget runs its own query, about 6 per page.');
root.append(table(['Who', 'Period', 'What it reads', 'Per page load'], [
  ['Guest', '7, 30 or 90 days', 'stats/7d.json, 30d.json or 90d.json, refreshed daily', num('$0')],
  ['Signed in', '24 hours, 3 days', 'The newest days\' small files in daily folders', num('≈ $0.004')],
  ['Signed in', '7 or 30 days', 'Those, plus one merged file per site and day in a month folder', num('≈ $0.005')],
  ['Signed in', '90 days', 'Those, plus about 660 merged files in 4 month folders', num('≈ $0.0065')],
]));
add('p', 'About $0.50 for 100 signed-in page loads, $5 for 1,000. Each search or "Show more" runs one more query.', 'dg-note');

add('h2', 'Why an Athena query costs what it does');
add('p', 'Athena charges $5 per TB scanned with a 10 MB minimum, about $0.00005 a query; the logs are small, so every query pays only the minimum. The real cost is S3: Athena lists every folder it reads ($0.005 per 1,000 lists) and reads every file in it ($0.0004 per 1,000 reads). So the bill depends on how many folders and files a query touches, not on how much data they hold.');
root.append(table(['Layout', 'Folders listed for 90 days', 'Files read for 90 days'], [
  ['A folder per site and day, as CloudFront writes them', '≈ 720 (+ 90 bot verdict folders)', '≈ 31,000'],
  ['Merged: one file per site and day, in a folder per month (used)', '≈ 4 (+ 7 daily days)', '≈ 660 (+ the newest days\' small files)'],
]));
root.append(callout('clock', 'The newest 3 days stay in daily folders with every request, bots included, so the bot check can judge them again. Most of what a query costs now is those days\' small files: about 1,050 of them.'));

root.append(flow({
  title: 'What keeps the bill small',
  steps: [
    { icon: 'power', title: 'No idle servers', text: 'Lambda and Athena run only when used' },
    { icon: 'page', title: 'Static for guests', text: 'Public totals are files, written once a day' },
    { icon: 'stack', title: 'Merged days', text: 'Days older than 3 become one file per site, in a folder per month' },
    { icon: 'filter', title: 'Partitions', text: 'Queries read only the chosen sites, days and months' },
    { icon: 'budget', title: 'Scan cap', text: 'Each query stops at 1 GB scanned' },
    { icon: 'clock', title: 'Result reuse', text: 'The same query within 5 minutes is free' },
    { icon: 's3', title: 'Lifecycle', text: 'Raw files deleted after 7 days, logs after 1 year', tone: 'good' },
  ],
}));

add('h2', 'Live queries for guests (not used)');
add('p', 'Guests could run the same live queries as signed-in users, at about $0.005 per page load: about $0.50 a month for 100 visits, $5 for 1,000 and $50 for 10,000, with no upper limit. Pre-computed files cost about $0.08 a month whatever the traffic, so guests get those.');

add('p', 'Prices are for eu-west-1 (Ireland) and us-east-1 log delivery in October 2026. File counts were measured on the live log bucket. Without dashboard use the monitor costs about $2.80 a year. Costs grow with traffic: roughly one extra log file per site per busy 5-minute period, $0.25 per extra GB of logs and $0.10 per million requests.', 'dg-note');

const footer = document.createElement('footer');
footer.textContent = 'Source: dliu-com/traffic-monitor (lib/traffic-monitor-stack.ts, lambda/dashboard/compact.js).';
root.append(footer);
