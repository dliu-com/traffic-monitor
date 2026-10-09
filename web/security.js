import { tiers, stats, table, callout, more } from './diagram.js';

const root = document.getElementById('security');
const add = (tag, text) => {
  const node = document.createElement(tag);
  node.textContent = text;
  root.append(node);
  return node;
};
const PASS = { text: '✓ Pass', className: 'status' };
const FIXED = { text: '✓ Fixed', className: 'status fixed' };
const LOW = { text: 'Low', className: 'risk-low' };
const MEDIUM = { text: 'Medium', className: 'risk-medium' };

root.append(callout('shield', 'Reviewed and tested against the live site on 9 October 2026. Four issues were found and fixed the same day; none exposed data.'));

root.append(tiers({
  title: 'Trust boundaries',
  rows: [
    {
      label: 'Anyone', badge: 'Untrusted', tone: 'untrusted',
      nodes: [
        { icon: 'browser', title: 'Site visitors', text: 'Control their user agent, referrer, path, query and cookies, all of which end up in the logs' },
        { icon: 'bot', title: 'Attackers', text: 'Can call traffic.dliu.com, its /api and /auth paths, and any AWS endpoint directly' },
      ],
    },
    {
      label: 'CloudFront', badge: 'Edge', tone: 'edge', link: 'HTTPS only, GET and HEAD only',
      nodes: [
        { icon: 'cloudfront', title: 'Dashboard distribution', text: 'TLS 1.2+, security headers, static pages from a private bucket' },
        { icon: 'cookie', title: 'Visitor ID function', text: 'Replaces any dl_vid that is not a plain random ID' },
      ],
    },
    {
      label: 'Dashboard Lambda', badge: 'API', tone: 'app', link: 'signed by CloudFront (IAM)',
      nodes: [
        { icon: 'lock', title: 'Session check', text: 'Every /api call needs a valid signed session cookie' },
        { icon: 'filter', title: 'Input allowlists', text: 'Sites, ranges, dates, times, visitor IDs, IPs and search text are validated before any SQL is built' },
      ],
    },
    {
      label: 'AWS account', badge: 'Private', tone: 'private', link: 'least-privilege role',
      nodes: [
        { icon: 's3', title: 'Log buckets', text: 'No public access, encrypted, HTTPS only' },
        { icon: 'athena', title: 'Athena', text: 'Read-only queries, 1 GB scan cap' },
        { icon: 'ssm', title: 'Parameter Store', text: 'Client secret stored encrypted, never in code' },
      ],
    },
  ],
  note: 'Everything above the Lambda is treated as hostile. Log fields are attacker-controlled data, so they are only ever displayed as text and never placed into SQL.',
}));

add('h2', 'Public limits');
root.append(stats([
  ['1 GB', 'maximum data scanned per query', 'budget'],
  ['366 days', 'longest custom date range', 'clock'],
  ['100 rows', 'most rows returned per call', 'filter'],
  ['12 hours', 'session lifetime', 'lock'],
]));

add('h2', 'Live penetration test');
add('p', 'Each test was run against https://traffic.dliu.com with curl, openssl and a small Node script. The signed-in tests used a real session.');
root.append(table(['Test', 'Result', 'Status'], [
  ['HTTP downgrade', 'http:// answers 301 to https://; HSTS is set for one year', PASS],
  ['Old TLS versions', 'TLS 1.0 and 1.1 are refused; TLS 1.2 and 1.3 work', PASS],
  ['Security headers', "CSP allows scripts only from the site itself (no inline scripts); framing is denied; nosniff; no referrer sent", PASS],
  ['Browser feature and window isolation headers', 'Permissions-Policy and Cross-Origin-Opener-Policy were missing; both are now sent', FIXED],
  ['Hidden files', '/.git/config, /.env, source maps, package.json, cdk.json and the site list all return 403; no directory listing', PASS],
  ['Other HTTP methods', 'POST, PUT, DELETE, PATCH and OPTIONS return 403; TRACE 405; CONNECT 400', PASS],
  ['Path tricks', 'Encoded ../, null bytes, upper case and double slashes never reach the API (400, 403 or 404)', PASS],
  ['Forged sessions', 'No cookie, unsigned, alg:none, swapped payload, expired, wrong key, truncated signature and fake user headers all return 401', PASS],
  ['Sign-in callback', 'Missing or forged state returns 400; the return address is fixed, so there is no open redirect', PASS],
  ['Sign-in error text', 'Arbitrary text in ?error= was shown on the page (escaped, so not executable). Only known error codes are shown now', FIXED],
  ['Header injection', 'Line breaks in callback parameters cannot add headers or cookies', PASS],
  ['Cross-origin requests', 'No CORS headers are sent, so other sites cannot read the API; preflight returns 403', PASS],
  ['Bypassing CloudFront', 'The Lambda function URL and all three S3 buckets return 403 when called directly', PASS],
  ['SQL injection', "Quotes, comments and UNION payloads in site, range, from, to, visitor, ip, list and part return 400. Search text with quotes, semicolons or angle brackets returns 400; other words are only ever matched as plain text", PASS],
  ['Prototype keys', 'range=__proto__ or toString caused a 500 error; they now return 400', FIXED],
  ['Oversized requests', 'Ranges over 366 days and repeated parameters return 400; limit is clamped to 1–100', PASS],
  ['Stored XSS', 'Script and onerror payloads were sent to dliu.com in the user agent, referrer, path, query and cookie, then viewed in the dashboard. They appear as plain text and nothing runs', PASS],
  ['Malicious visitor cookie', 'A dl_vid containing <script> is replaced with a fresh random ID', PASS],
  ['Error page styling', 'The error page used an inline style that the CSP blocked; it now uses the stylesheet', FIXED],
  ['Secrets in the public repo', 'Full git history scanned: no secrets, keys, account, tenant or client IDs', PASS],
  ['Dependencies', 'No third-party packages run in production; 34 advisories affect only the local test tools', PASS],
]));

add('h2', 'Threat model');
root.append(table(['Scenario', 'Residual risk', 'Controls'], [
  ['A visitor puts a script in their user agent, referrer or URL so it runs when the admin views the logs (stored XSS)', LOW, 'Every value is rendered with textContent, never innerHTML; CSP blocks inline and third-party scripts; tested with live payloads'],
  ['A crafted sign-in link shows misleading text or script (reflected XSS)', LOW, 'Output is HTML-escaped; only known OAuth error codes are displayed'],
  ['Filters are used to inject SQL into Athena', LOW, 'Sites, ranges, lists and parts come from fixed lists; dates, times, visitor IDs and IPs must match strict patterns; search text is limited to letters, digits and a few safe symbols; no user-written SQL; the role can only read'],
  ['An attacker forges or steals a session cookie', LOW, 'HMAC-SHA256 signature, 12-hour expiry, HttpOnly, Secure, SameSite=Lax, __Host- prefix so sibling subdomains cannot set it'],
  ['Login CSRF, code interception or an open redirect', LOW, 'state, nonce and PKCE (S256); fixed redirect URI; ID token signature, issuer, tenant, audience and expiry checked'],
  ['Someone with another Microsoft account signs in', LOW, 'Single-tenant app with assignment required, plus an @dliu.com domain check in the Lambda'],
  ['The Lambda or buckets are called without CloudFront', LOW, 'Function URL requires IAM auth from CloudFront (OAC); buckets block public access and allow only CloudFront'],
  ['The dashboard is framed for clickjacking', LOW, "frame-ancestors 'none', X-Frame-Options DENY and Cross-Origin-Opener-Policy"],
  ['Fake dl_vid cookies or scripted requests distort the numbers', MEDIUM, 'Cookie format is validated and bots are flagged; the data is analytics only and grants no access'],
  ['Request floods run up the bill', LOW, 'Queries need sign-in; each query stops at 1 GB scanned; repeat queries reuse results for 5 minutes; unauthenticated calls return 401 cheaply'],
  ['Secrets leak through the public repository', LOW, 'The client secret, tenant and client IDs live in encrypted SSM parameters read at run time; git history scanned'],
  ['Logged IP addresses and visitor IDs are exposed', MEDIUM, 'Only the admin can query them; buckets are private and encrypted; raw logs deleted after 7 days, sorted logs after 1 year'],
]));

add('h2', 'Accepted residual risks');
const risks = document.createElement('ul');
for (const text of [
  'There is no WAF or rate limit. Unauthenticated calls to /api or /auth still start the Lambda, which answers 401 for a tiny cost.',
  'Visitor IDs are not cryptographically random and anyone can set their own dl_vid. They are for counting visitors, not for security.',
  'Logs contain IP addresses and visitor IDs (personal data) for up to one year.',
  'Sessions cannot be revoked on the server; a stolen cookie works until it expires (at most 12 hours).',
  'Sign-out is a plain link, so another site could sign the admin out. Nothing else can be triggered that way.',
  'Unknown pages return 403 rather than 404, because the bucket does not allow listing.',
  'HSTS does not cover subdomains and is not preloaded, because other dliu.com subdomains are managed separately.',
  'The domain check relies on the account name, which only directory administrators can change.',
  'The local test tools have 34 known advisories; they never run in production.',
  'There is no security.txt file.',
]) {
  const li = document.createElement('li');
  li.textContent = text;
  risks.append(li);
}
root.append(risks);

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
detailList('Response headers', [
  "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://files.dliu.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Strict-Transport-Security: max-age=31536000',
  'X-Frame-Options: DENY · X-Content-Type-Options: nosniff · Referrer-Policy: no-referrer',
  'Permissions-Policy: camera, microphone, geolocation, payment, usb and interest-cohort disabled',
  'Cross-Origin-Opener-Policy: same-origin · X-Robots-Tag: noindex, nofollow',
  'API responses also send Cache-Control: no-store',
]);
detailList('Sign-in and session', [
  'Authorization code flow with PKCE (S256), state and nonce, held for 10 minutes in a __Host-tm_auth cookie',
  'ID token verified with Node crypto against Microsoft’s published keys: RS256 signature, issuer, tenant, audience, nonce, and expiry with 2 minutes of clock skew',
  'Session cookie __Host-tm_session: HMAC-SHA256 with a key derived from the client secret, 12 hours, HttpOnly, Secure, SameSite=Lax, host-only',
]);
detailList('AWS', [
  'The Lambda role can only run queries in its own Athena workgroup, read its Glue table, read parameters under /traffic-monitor/ and use its own bucket prefixes',
  'All buckets block public access, use S3-managed encryption and reject plain HTTP',
  'Athena workgroup settings are enforced, so a query cannot raise its own scan limit',
]);
details.append(document.createElement('h3'));
details.lastChild.textContent = 'Further reading';
const links = document.createElement('ul');
for (const [href, text] of [
  ['https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html', 'OWASP XSS prevention cheat sheet'],
  ['https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html', 'OWASP input validation cheat sheet'],
  ['https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html', 'OWASP REST security cheat sheet'],
  ['https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html', 'OWASP session management cheat sheet'],
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
footer.textContent = 'Source: dliu-com/traffic-monitor · See also the About page for the architecture and cost.';
root.append(footer);
