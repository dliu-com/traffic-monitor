import { flow, tiers, stats, table, cards, more } from './diagram.js';

const root = document.getElementById('about');

function section(title, ...paragraphs) {
  const h2 = document.createElement('h2');
  h2.textContent = title;
  root.append(h2);
  for (const text of paragraphs) {
    const p = document.createElement('p');
    p.textContent = text;
    root.append(p);
  }
}

function list(items) {
  const ul = document.createElement('ul');
  for (const [term, text] of items) {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = term;
    li.append(strong, ' — ' + text);
    ul.append(li);
  }
  root.append(ul);
}

root.append(stats([
  ['0 servers', 'running while nobody visits', 'power'],
  ['< $1 / month', 'for all sites together', 'budget'],
  ['≈ 5 min', 'from visit to dashboard', 'clock'],
  ['1 year', 'of request history', 'chart'],
]));

section('Technical architecture');
root.append(tiers({
  title: 'System map',
  rows: [
    {
      label: 'Visitors', badge: 'Internet', tone: 'untrusted',
      nodes: [
        { icon: 'browser', title: 'Browsers', text: 'People visiting any dliu.com site' },
        { icon: 'bot', title: 'Bots', text: 'Crawlers and scripts, flagged by user agent' },
      ],
    },
    {
      label: 'Each site', badge: 'Edge', tone: 'edge', link: 'every request',
      nodes: [
        { icon: 'cloudfront', title: 'CloudFront', text: 'Serves the site from S3 or Lambda and writes a log line per request, with the visitor’s country' },
        { icon: 'cookie', title: 'Visitor ID function', text: 'Shared CloudFront Function that sets the dl_vid cookie and writes the ID into the log' },
      ],
    },
    {
      label: 'Log pipeline', badge: 'Private', tone: 'private', link: 'log files, a few minutes later',
      nodes: [
        { icon: 's3', title: 'Log bucket', text: 'raw-v2/<site>/ then logs/site=<site>/dt=<day>/' },
        { icon: 'lambda', title: 'Partitioner', text: 'Puts each new log file’s columns in a fixed order and files it by site and day' },
        { icon: 'glue', title: 'Glue table', text: 'Describes the log columns and partitions' },
      ],
    },
    {
      label: 'Dashboard', badge: 'App', tone: 'app', link: 'queried on demand',
      nodes: [
        { icon: 'cloudfront', title: 'traffic.dliu.com', text: 'Static pages from S3; /api and /auth go to Lambda' },
        { icon: 'lambda', title: 'Dashboard Lambda', text: 'Microsoft sign-in and Athena queries' },
        { icon: 'athena', title: 'Athena', text: 'SQL over the logs, reading only the chosen sites and days' },
      ],
    },
  ],
  note: 'The sites only attach the shared function; the monitor sets up their CloudFront log delivery (standard logging v2, created in us-east-1). The sites never call the monitor, so it can never slow a site down or take it offline.',
}));

root.append(flow({
  title: 'Life of one request',
  numbered: true,
  steps: [
    { icon: 'browser', title: 'Visit', text: 'A browser requests a page, file or API call' },
    { icon: 'cloudfront', title: 'Serve', text: 'CloudFront answers from cache, S3 or Lambda' },
    { icon: 'cookie', title: 'Tag', text: 'dl_vid is added if the browser has none, and logged either way' },
    { icon: 's3', title: 'Log', text: 'CloudFront delivers the log file to raw-v2/<site>/' },
    { icon: 'lambda', title: 'Sort', text: 'The partitioner files it by site and day' },
    { icon: 'chart', title: 'Show', text: 'Athena reads it when the dashboard loads' },
  ],
  note: 'Requests that go to a Lambda behind CloudFront, such as the Weiqi API, are logged the same way as static files.',
}));

section('What is recorded');
list([
  ['Time', 'when CloudFront received the request (UTC, shown in your time zone)'],
  ['IP address', 'the address the request came from'],
  ['Country and network', 'the country and the network (ASN) CloudFront places the IP in; nothing finer, such as a city'],
  ['Visitor', 'the dl_vid ID, or the IP address when there is none (bots and cookie-blocking browsers)'],
  ['Request', 'site, method, path, query string, status code and bytes sent'],
  ['Browser', 'user agent and referrer, used to spot bots and external links'],
]);

root.append(flow({
  title: 'Recognising the same visitor',
  steps: [
    { icon: 'user', title: 'First visit', text: 'The browser has no dl_vid cookie' },
    { icon: 'cookie', title: 'Cookie set', text: 'A random ID on .dliu.com, kept for one year, and written into that request’s log line' },
    { icon: 'link', title: 'Every site', text: 'The browser sends it to all dliu.com subdomains' },
    { icon: 'eye', title: 'Grouped', text: 'The dashboard counts requests per dl_vid', tone: 'good' },
  ],
  note: 'The cookie is HttpOnly and holds only a random ID, never personal data. Because the function logs the ID it sets, even the very first request is counted under it. Cookie-blocking browsers and most bots get a new ID each time, so they are counted by IP address instead.',
}));

section('Authentication', 'The dashboard is private. Every API call needs a signed session that can only be obtained by signing in with a Microsoft work account in the dliu.com directory. The About and Security pages are public.');

root.append(flow({
  title: 'Signing in',
  numbered: true,
  steps: [
    { icon: 'browser', title: 'Sign in', text: '/auth/login creates state, nonce and a PKCE code' },
    { icon: 'entra', title: 'Microsoft', text: 'Entra signs you in; only assigned users get through' },
    { icon: 'key', title: 'Verify', text: 'The Lambda checks the ID token signature and claims' },
    { icon: 'shield', title: 'Domain', text: 'The account must be an @dliu.com user' },
    { icon: 'lock', title: 'Session', text: 'A signed cookie, valid for 12 hours', tone: 'good' },
  ],
  note: 'The client secret lives in SSM Parameter Store, not in the code. The sign-in cookie that carries state, nonce and PKCE expires after 10 minutes.',
}));

section('Cost', 'Nothing runs while nobody is visiting, so there is no fixed monthly fee. Each part is billed per use, and at the traffic of the dliu.com sites almost everything stays inside the AWS free tier or rounds to zero.');

root.append(stats([
  ['≈ $0.25', 'per month for logging all sites', 'budget'],
  ['≈ $0.0003', 'per dashboard page load (Athena)', 'athena'],
  ['$0.03', 'worst case per load, capped by the scan limit', 'shield'],
]));

root.append(table(['Part', 'How it is billed', 'Typical month'], [
  ['CloudFront log delivery (standard logging v2)', '$0.25 per GB of log lines delivered to S3; about 0.2 to 0.4 GB a month', { text: '≈ $0.10', className: 'num' }],
  ['Visitor ID function', '$0.10 per million site requests', { text: '< $0.01', className: 'num' }],
  ['S3 requests', 'About 11,000 log files a month; each is written, read, rewritten and deleted once ($0.005 per 1,000 writes)', { text: '≈ $0.12', className: 'num' }],
  ['S3 storage', 'Gzipped logs of about 25 MB a month, kept for one year', { text: '< $0.01', className: 'num' }],
  ['Partitioner Lambda', 'One short call per log file', { text: '$0 (free tier)', className: 'num' }],
  ['Athena', '$5 per TB scanned, 10 MB minimum per query; a dashboard page runs 5 or 6 queries, and each search or "Show more" runs one more', { text: '≈ $0.03 for 100 loads', className: 'num' }],
  ['Dashboard Lambda, CloudFront, Glue, SSM', 'Per request, or free at this size', { text: '$0', className: 'num' }],
]));
root.append(Object.assign(document.createElement('p'), {
  className: 'dg-note',
  textContent: 'Prices are for eu-west-1 (Ireland) and us-east-1 log delivery in October 2026. File counts were measured on the live log bucket. With one peak day a week the whole monitor costs about $2.60 a year, and about $5 in a bad year. Costs grow with traffic: roughly one extra log file per site per busy 5-minute period, $0.25 per extra GB of logs and $0.10 per million requests.',
}));

root.append(flow({
  title: 'What keeps the bill small',
  steps: [
    { icon: 'power', title: 'No idle servers', text: 'Lambda and Athena run only when used' },
    { icon: 'filter', title: 'Partitions', text: 'Queries read only the chosen sites and days' },
    { icon: 'budget', title: 'Scan cap', text: 'Each query stops at 1 GB scanned' },
    { icon: 'clock', title: 'Result reuse', text: 'The same query within 5 minutes is free' },
    { icon: 's3', title: 'Lifecycle', text: 'Raw files deleted after 7 days, logs after 1 year', tone: 'good' },
  ],
}));

section('Security', 'The monitor stores data that visitors control, such as their browser name and the address they typed, so every logged value is treated as hostile. It is shown on the dashboard as plain text and never placed into SQL. The site was threat-modelled and penetration-tested on 9 October 2026; the four issues found were fixed the same day.');

root.append(tiers({
  title: 'Layers of protection',
  rows: [
    {
      label: 'Microsoft Entra', badge: 'Identity', tone: 'edge',
      nodes: [
        { icon: 'entra', title: 'Single tenant', text: 'Only accounts in the dliu.com directory can sign in' },
        { icon: 'users', title: 'Assignment required', text: 'Only users assigned to the app (Global Administrators are exempt)' },
      ],
    },
    {
      label: 'Dashboard Lambda', badge: 'Checks', tone: 'private', link: 'ID token',
      nodes: [
        { icon: 'key', title: 'Token checks', text: 'Signature, issuer, tenant, audience, nonce and expiry' },
        { icon: 'shield', title: 'Domain check', text: 'Username or email must end in @dliu.com' },
        { icon: 'lock', title: 'Session cookie', text: 'HMAC-signed, HttpOnly, Secure, SameSite=Lax' },
      ],
    },
    {
      label: 'Browser and AWS', badge: 'Infra', tone: 'app', link: 'every request',
      nodes: [
        { icon: 'code', title: 'No script injection', text: 'Values shown as text; CSP allows only the site’s own scripts' },
        { icon: 'cloudfront', title: 'CloudFront only', text: 'The Lambda URL and S3 buckets accept requests from CloudFront alone' },
        { icon: 'filter', title: 'Fixed queries', text: 'Filters are validated; no user-written SQL' },
        { icon: 'budget', title: 'Scan limit', text: 'Each Athena query stops at 1 GB scanned' },
      ],
    },
  ],
}));

section('Read more');
root.append(cards([
  ['/security', 'shield', 'Security review', 'Live penetration test, threat model and accepted risks', '21 tests, 4 fixes · 9 Oct 2026'],
  ['https://github.com/dliu-com/traffic-monitor', 'code', 'Source code', 'The CDK stack, Lambdas, functions and these pages', 'Public on GitHub'],
]));

const details = document.createElement('div');
function detailList(title, items) {
  const h3 = document.createElement('h3');
  h3.textContent = title;
  const ul = document.createElement('ul');
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    ul.append(li);
  }
  details.append(h3, ul);
}
detailList('Components', [
  'Two AWS CDK stacks (TypeScript): TrafficMonitor in eu-west-1, and TrafficLogDelivery in us-east-1, where CloudFront log deliveries must live. Each site’s own stack only attaches the shared function and keeps cookie logging on.',
  'Visitor ID: a CloudFront Function (cloudfront-js-2.0) on viewer response that sets dl_vid on .dliu.com for one year and writes the ID into the log with cf.logCustomData.',
  'Log delivery: CloudFront standard logging (v2) for each site’s distribution, writing 36 tab-separated fields (the 33 classic ones plus c-country, asn and viewer-response-log-data) to raw-v2/<site>/YYYY/MM/DD/.',
  'Log bucket: the partitioner Lambda (Node.js) reorders each file’s columns by its #Fields header, gzips it into logs/site=<site>/dt=<day>/ and deletes the raw file. Only the log delivery service of this account may write to raw-v2/.',
  'Glue table cloudfront_logs with partition projection over site and day, so no crawler or partition updates are needed.',
  'Athena workgroup traffic with an enforced 1 GB scan cutoff and 5-minute result reuse.',
  'Dashboard: static HTML, CSS and JavaScript in a private S3 bucket behind CloudFront; /api/* and /auth/* go to a Node.js Lambda function URL secured with IAM and origin access control.',
]);
detailList('Data and retention', [
  'Each log line has 36 fields; the dashboard uses time, IP, country, network (ASN), site, method, path, query, status, bytes, user agent, referrer and the dl_vid ID.',
  'Country comes from CloudFront’s own IP lookup, so there is no geolocation database to update. Requests logged before 9 October 2026 have no country and show as Unknown.',
  'Visitors are counted by the dl_vid cookie the browser sent. A request without one, such as a first visit, counts under the ID the function logged, provided that ID came back as a cookie in the same period; otherwise it counts by IP. Requests whose user agent looks like a crawler or script are flagged as bots, left out of visitor and page counts, and hidden in the request list by default.',
  'Raw files are deleted after 7 days, sorted logs after 365 days and Athena results after 7 days.',
  'Sites are listed in config/sites.json; adding a site there adds its partition and its card on the dashboard.',
]);
detailList('Dashboard queries', [
  'Each widget runs its own query and appears as soon as its answer arrives, with a spinner until then, so a slow chart never holds up the totals.',
  'All sites page: seven queries for totals, visits over time, countries, the country filter list, per-site totals, per-site sparklines and IP addresses.',
  'Site page: eight queries for one site: totals, visits over time, countries, the country filter list, top pages, external referrers, IP addresses and its request log.',
  'Country filter: choosing a country (or clicking one in the Countries table) narrows every widget on the All sites and Site pages to that country; it is kept in the link as ?country=. The IP page always shows everything the IP did.',
  'IP page: five queries across all sites for that IP: summary (with country and network), sites visited, its dl_vid IDs, other IPs with the same ID, and its requests.',
  'Tables are paged in Athena: only the rows on screen are fetched (at most 100 per call), with a total count. Search and "Show more" run a new query instead of filtering rows already downloaded.',
  'Ranges: last 1 or 12 hours, 24 hours, 7, 30, 90 or 365 days, or a custom period of up to 366 days typed as YYYY-MM-DD HH:MM in your local time. Charts use minutes up to 3 hours, hours up to 3 days and days beyond that.',
  'All queries are built from fixed templates; user input is validated against allowlists and strict patterns first.',
]);
detailList('Deployment', [
  'make deploy runs the Jest tests, then cdk deploy; static files are uploaded and the CloudFront cache is cleared.',
  'Microsoft Entra settings are read from SSM Parameter Store at run time, so the public repository contains no IDs or secrets.',
]);
root.append(more('More technical details (text)', details));

const footer = document.createElement('footer');
footer.textContent = 'Source: dliu-com/traffic-monitor';
root.append(footer);
