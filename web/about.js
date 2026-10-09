import { flow, tiers, stats } from './diagram.js';

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
  ['$0 idle', 'no servers; pay per request', 'power'],
  ['7 sites', 'every *.dliu.com site', 'cloudfront'],
  ['~5 min', 'from visit to dashboard', 'clock'],
  ['1 year', 'of request history', 'chart'],
]));

section('Architecture');
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

section('Authentication', 'The dashboard is private. Every API call needs a signed session that can only be obtained by signing in with a Microsoft work account in the dliu.com directory.');

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
      label: 'AWS', badge: 'Infra', tone: 'app', link: 'every request',
      nodes: [
        { icon: 'cloudfront', title: 'CloudFront only', text: 'The Lambda URL and S3 bucket accept requests from CloudFront alone' },
        { icon: 'filter', title: 'Fixed queries', text: 'Filters are validated; no user-written SQL' },
        { icon: 'budget', title: 'Scan limit', text: 'Each Athena query stops at 1 GB scanned' },
      ],
    },
  ],
}));

section('Cost', 'There is nothing to pay for while nobody is looking. CloudFront log delivery, the visitor function, S3 storage and the partitioner cost fractions of a cent per thousand requests. Athena charges per data scanned, and only when the dashboard is open. Logs are kept for one year and then deleted automatically.');

const footer = document.createElement('footer');
footer.textContent = 'Source: dliu-com/traffic-monitor';
root.append(footer);
