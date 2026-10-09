# traffic-monitor

Central traffic monitoring for the `*.dliu.com` sites (S3/Lambda behind CloudFront).

- **Capture** – CloudFront standard logging (v2) delivers each site's access logs (with cookies, country and ASN)
  to one central S3 bucket. The deliveries live in a second stack, `TrafficLogDelivery`, in us-east-1.
- **Identify visitors** – a shared CloudFront Function (`dliu-visitor-id`, viewer-response) sets a first-party
  `dl_vid` cookie on `.dliu.com`, so the same visitor is recognised across all subdomains. It also writes the ID
  into the log line (`cf.logCustomData`), so a visitor's first request, sent before they had the cookie, counts under the same ID.
- **Query** – a partitioner Lambda puts each file's columns in a fixed order and moves it into `logs/site=<site>/dt=<date>/`;
  Glue + Athena (partition projection) query them.
- **Dashboard** – `https://traffic.dliu.com`, private, Microsoft 365 (Entra ID) sign-in handled by the API Lambda (no Cognito).
  - `/` **All sites** – totals, visits over time, countries, a card per site (page views, visitors, IPs, last visit, sparkline) and the latest IP addresses.
  - `/site?site=<key>` **Site** – one site's chart, countries, top pages, referrers, IP addresses and request log.
  - `/ip?ip=<address>` **IP** – everything one IP did across all sites (with its country and network), plus other IPs with the same `dl_vid`.
  - A country filter (`?country=GB`, or `unknown`) narrows the All sites and Site pages; click a country in the Countries table to apply it.
  - The period (1h, 12h, 24h, 7d, 30d, 90d, 1y, or a custom `YYYY-MM-DD HH:MM` period in local time, sent as UTC) is kept in the URL, so links can be shared and reloaded.
  - Every widget loads on its own (`/api/overview` and `/api/ip` take `part=`), with a spinner until its data arrives.
  - Tables are paged and searched in Athena through `/api/list`, so only the rows on screen are downloaded (at most 100 per call).
- **About** – `https://traffic.dliu.com/about`, public diagrams of the architecture, sign-in flow, cost and security.
- **Security** – `https://traffic.dliu.com/security`, the threat model, live penetration-test results and accepted risks.

```
site CloudFront ──v2 logs──▶ S3 raw-v2/<site>/YYYY/MM/DD/ ──▶ partitioner λ ──▶ S3 logs/site=/dt=/ ◀── Athena ◀── dashboard λ ◀── traffic.dliu.com
        └─ viewer-response: dliu-visitor-id (sets dl_vid, logs it)
```

Cost at low traffic: roughly $0.10–0.40/month (log delivery at $0.25/GB, S3 requests and storage, Athena scans of a few MB,
Lambda/CloudFront free tier) — about $2.60 a year with one peak day a week.

## Deploy

First copy `config/distributions.example.json` to `config/distributions.local.json` (gitignored) and fill in each
site's CloudFront distribution ID.

```bash
make install
make test
make deploy        # "TrafficMonitor" in eu-west-1 (needs the DNS stack exports MainDomain / MainHostedZoneId),
                   # then "TrafficLogDelivery" in us-east-1 (needs `cdk bootstrap` there once)
make outputs
```

## Microsoft 365 / Entra sign-in

Microsoft 365 Business Basic (Entra ID Free) is sufficient. Using an admin account at https://entra.microsoft.com:

1. **App registrations → New registration**: name `Traffic Monitor`, *single tenant*,
   redirect URI platform **Web** = `https://traffic.dliu.com/auth/callback`.
2. Copy **Application (client) ID** and **Directory (tenant) ID** from *Overview*.
3. **Certificates & secrets → New client secret** — copy the secret **Value** (shown once).
4. **API permissions**: default `User.Read` → *Grant admin consent*.
5. **Enterprise applications → Traffic Monitor** → *Assignment required = Yes*, and assign the users who may sign in. Microsoft decides who gets in; note that Entra skips this check for Global Administrators.
6. Store the settings (prompted interactively, saved to SSM Parameter Store under `/traffic-monitor/`):

   ```bash
   make set-secrets
   ```

No secrets live in this repository. Besides verifying the Microsoft ID token (signature, tenant, audience, nonce, expiry), the dashboard only checks that the account's email is in the site's domain (`@dliu.com`, from the `MainDomain` export).
Renew the client secret before it expires and re-run `make set-secrets`.

## Adding a site

1. Add the site's key and host to `config/sites.json`, its CloudFront distribution ID to the gitignored
   `config/distributions.local.json` (format: `config/distributions.example.json`), and run `make deploy`;
   this creates its log delivery to `raw-v2/<site-key>/`.
2. In the site's CDK stack (same account/region), attach the visitor function and turn on cookie logging
   (without a legacy log bucket):

```js
const visitorId = cloudfront.Function.fromFunctionAttributes(this, 'VisitorId', {
  functionArn: cdk.Fn.importValue('TrafficVisitorFunctionArn'),
  functionName: 'dliu-visitor-id',
});

const distribution = new cloudfront.Distribution(this, 'Distribution', {
  // ...existing props
  defaultBehavior: {
    // ...existing props
    functionAssociations: [
      // ...existing associations
      { eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE, function: visitorId },
    ],
  },
});
// Cookie logging for standard logging (v2); no legacy log bucket.
(distribution.node.defaultChild as cloudfront.CfnDistribution)
  .addPropertyOverride('DistributionConfig.Logging', { IncludeCookies: true });
```

Deploy `TrafficMonitor` before any site; it can't be deleted while sites import its exports.

## Notes

- Visitors are identified by the `dl_vid` cookie sent; a request without one uses the ID the function logged if that ID
  later came back as a cookie in the queried period (so cookie-less bots don't count once per request), then `ip:<address>`
  (bots and cookie-blocking browsers). Responses the function does not run on (e.g. some origin errors) use the cookie.
- Country and ASN come from CloudFront itself; requests before the switch to v2 (about 21:00 UTC on 9 Oct 2026)
  have none.
- Legacy logs (`raw/<site>/`) are filed only up to `LEGACY_LAST_HOUR` in `lambda/partitioner/index.js`; later ones
  are deleted, since v2 already has those requests. The overlap hour was cleaned with
  `node scripts/dedupe-overlap.js --bucket <log bucket>`, which drops legacy rows whose request ID is also in a v2 file.
- CloudFront logs arrive with a delay of a few minutes.
- Logs are kept for 1 year; raw (unpartitioned) files for 7 days.
- The `dl_vid` cookie is set without a consent banner; consider your local cookie rules (e.g. UK PECR).
