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
        { icon: 'cloudfront', title: 'CloudFront', text: 'Serves the site from S3 or Lambda and writes a log line per request' },
        { icon: 'cookie', title: 'Visitor ID function', text: 'Shared CloudFront Function that sets the dl_vid cookie' },
      ],
    },
    {
      label: 'Log pipeline', badge: 'Private', tone: 'private', link: 'log files, a few minutes later',
      nodes: [
        { icon: 's3', title: 'Log bucket', text: 'raw/<site>/ then logs/site=<site>/dt=<day>/' },
        { icon: 'lambda', title: 'Partitioner', text: 'Moves each new log file into its site and day folder' },
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
  note: 'The sites only point their CloudFront logging at the shared bucket and attach the shared function. They do not call the monitor, so it can never slow a site down or take it offline.',
}));

root.append(flow({
  title: 'Life of one request',
  numbered: true,
  steps: [
    { icon: 'browser', title: 'Visit', text: 'A browser requests a page, file or API call' },
    { icon: 'cloudfront', title: 'Serve', text: 'CloudFront answers from cache, S3 or Lambda' },
    { icon: 'cookie', title: 'Tag', text: 'dl_vid is added if the browser has none' },
    { icon: 's3', title: 'Log', text: 'CloudFront delivers the log file to raw/<site>/' },
    { icon: 'lambda', title: 'Sort', text: 'The partitioner files it by site and day' },
    { icon: 'chart', title: 'Show', text: 'Athena reads it when the dashboard loads' },
  ],
  note: 'Requests that go to a Lambda behind CloudFront, such as the Weiqi API, are logged the same way as static files.',
}));

section('What is recorded');
list([
  ['Time', 'when CloudFront received the request (UTC, shown in your time zone)'],
  ['IP address', 'the address the request came from'],
  ['Visitor', 'the dl_vid cookie, or the IP address when there is no cookie yet'],
  ['Request', 'site, method, path, query string, status code and bytes sent'],
  ['Browser', 'user agent and referrer, used to spot bots and external links'],
]);

root.append(flow({
  title: 'Recognising the same visitor',
  steps: [
    { icon: 'user', title: 'First visit', text: 'The browser has no dl_vid cookie' },
    { icon: 'cookie', title: 'Cookie set', text: 'A random ID on .dliu.com, kept for one year' },
    { icon: 'link', title: 'Every site', text: 'The browser sends it to all dliu.com subdomains' },
    { icon: 'eye', title: 'Grouped', text: 'The dashboard counts requests per dl_vid', tone: 'good' },
  ],
  note: 'The cookie is HttpOnly and holds only a random ID, never personal data. The very first request, cookie-blocking browsers and most bots fall back to their IP address.',
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
  ['≈ $0.15', 'per month for logging all sites', 'budget'],
  ['≈ $0.0004', 'per dashboard page load (Athena)', 'athena'],
  ['$0.04', 'worst case per load, capped by the scan limit', 'shield'],
]));

root.append(table(['Part', 'How it is billed', 'Typical month'], [
  ['CloudFront log delivery', 'Free; you only pay S3 for the files', { text: '$0', className: 'num' }],
  ['Visitor ID function', '$0.10 per million site requests', { text: '< $0.01', className: 'num' }],
  ['S3 requests', 'About 11,000 log files a month; each is written once and copied once ($0.005 per 1,000)', { text: '≈ $0.12', className: 'num' }],
  ['S3 storage', 'Gzipped logs of about 25 MB a month, kept for one year', { text: '< $0.01', className: 'num' }],
  ['Partitioner Lambda', 'One short call per log file', { text: '$0 (free tier)', className: 'num' }],
  ['Athena', '$5 per TB scanned, 10 MB minimum per query; a dashboard page runs 4 to 8 queries', { text: '≈ $0.04 for 100 loads', className: 'num' }],
  ['Dashboard Lambda, CloudFront, Glue, SSM', 'Per request, or free at this size', { text: '$0', className: 'num' }],
]));
root.append(Object.assign(document.createElement('p'), {
  className: 'dg-note',
  textContent: 'Prices are for eu-west-1 (Ireland) in October 2026. File counts were measured on the live log bucket. Costs grow with traffic: roughly one extra log file per site per busy 5-minute period, plus $0.10 per million requests.',
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
  'One AWS CDK stack (TypeScript) in eu-west-1, plus a few lines in each site’s own stack to attach the shared function and log bucket.',
  'Visitor ID: a CloudFront Function (cloudfront-js-2.0) on viewer response that sets dl_vid on .dliu.com for one year.',
  'Log bucket: CloudFront standard logs with cookies, delivered to raw/<site>/ and moved to logs/site=<site>/dt=<day>/ by the partitioner Lambda (Node.js).',
  'Glue table cloudfront_logs with partition projection over site and day, so no crawler or partition updates are needed.',
  'Athena workgroup traffic with an enforced 1 GB scan cutoff and 5-minute result reuse.',
  'Dashboard: static HTML, CSS and JavaScript in a private S3 bucket behind CloudFront; /api/* and /auth/* go to a Node.js Lambda function URL secured with IAM and origin access control.',
]);
detailList('Data and retention', [
  'Each log line has 33 fields; the dashboard uses time, IP, site, method, path, query, status, bytes, user agent, referrer and the dl_vid cookie.',
  'Visitors are counted by dl_vid, or by IP when the cookie is missing. Requests whose user agent looks like a crawler or script are flagged as bots, left out of visitor and page counts, and hidden in the request list by default.',
  'Raw files are deleted after 7 days, sorted logs after 365 days and Athena results after 7 days.',
  'Sites are listed in config/sites.json; adding a site there adds its partition and its card on the dashboard.',
]);
detailList('Dashboard queries', [
  'All sites page: seven queries for totals, visits over time, per-site totals and sparklines, top pages, external referrers and IP addresses.',
  'Site page: the same seven queries for one site, plus its request log (up to 1,000 rows).',
  'IP page: four queries across all sites for that IP: summary, sites visited, other IPs that sent the same dl_vid cookie, and its requests (up to 1,000 rows).',
  'Ranges: last 24 hours, 7, 30, 90 or 365 days, or a custom range of up to 366 days.',
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
