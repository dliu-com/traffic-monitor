# traffic-monitor

Central traffic monitoring for the `*.dliu.com` sites (S3/Lambda behind CloudFront).

- **Capture** – each site's CloudFront distribution writes standard access logs (with cookies) to one central S3 bucket.
- **Identify visitors** – a shared CloudFront Function (`dliu-visitor-id`, viewer-response) sets a first-party
  `dl_vid` cookie on `.dliu.com`, so the same visitor is recognised across all subdomains.
- **Query** – a partitioner Lambda moves logs into `logs/site=<site>/dt=<date>/`; Glue + Athena (partition projection) query them.
- **Dashboard** – `https://traffic.dliu.com`, private, Microsoft 365 (Entra ID) sign-in handled by the API Lambda (no Cognito).
  - `/` **All sites** – totals, visits over time, a card per site (page views, visitors, IPs, last visit, sparkline) and the latest IP addresses.
  - `/site?site=<key>` **Site** – one site's chart, top pages, referrers, IP addresses and request log.
  - `/ip?ip=<address>` **IP** – everything one IP did across all sites, plus other IPs that sent the same `dl_vid` cookie.
  - The period (1h, 12h, 24h, 7d, 30d, 90d, 1y, or a custom `YYYY-MM-DD HH:MM` period in local time, sent as UTC) is kept in the URL, so links can be shared and reloaded.
  - Every widget loads on its own (`/api/overview` and `/api/ip` take `part=`), with a spinner until its data arrives.
  - Tables are paged and searched in Athena through `/api/list`, so only the rows on screen are downloaded (at most 100 per call).
- **About** – `https://traffic.dliu.com/about`, public diagrams of the architecture, sign-in flow, cost and security.
- **Security** – `https://traffic.dliu.com/security`, the threat model, live penetration-test results and accepted risks.

```
site CloudFront ──logs──▶ S3 raw/<site>/ ──▶ partitioner λ ──▶ S3 logs/site=/dt=/ ◀── Athena ◀── dashboard λ ◀── traffic.dliu.com
        └─ viewer-response: dliu-visitor-id (sets dl_vid)
```

Cost at low traffic: roughly $0–0.20/month (S3 storage, Athena scans of a few MB, Lambda/CloudFront free tier).

## Deploy

```bash
make install
make test
make deploy        # stack "TrafficMonitor" in eu-west-1 (needs the DNS stack exports MainDomain / MainHostedZoneId)
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

1. Add the site key to `config/sites.json` and redeploy this stack.
2. In the site's CDK stack (same account/region):

```js
const logBucket = s3.Bucket.fromBucketAttributes(this, 'TrafficLogs', {
  bucketName: cdk.Fn.importValue('TrafficLogBucketName'),
  region: 'eu-west-1',
});
const visitorId = cloudfront.Function.fromFunctionAttributes(this, 'VisitorId', {
  functionArn: cdk.Fn.importValue('TrafficVisitorFunctionArn'),
  functionName: 'dliu-visitor-id',
});

new cloudfront.Distribution(this, 'Distribution', {
  // ...existing props
  enableLogging: true,
  logBucket,
  logFilePrefix: 'raw/<site-key>/',
  logIncludesCookies: true,
  defaultBehavior: {
    // ...existing props
    functionAssociations: [
      // ...existing associations
      { eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE, function: visitorId },
    ],
  },
});
```

Deploy `TrafficMonitor` before any site; it can't be deleted while sites import its exports.

## Notes

- A visitor's very first request carries no cookie; the dashboard falls back to `ip:<address>` for it.
- CloudFront standard logs arrive with a delay of a few minutes.
- Logs are kept for 1 year; raw (unpartitioned) files for 7 days.
- The `dl_vid` cookie is set without a consent banner; consider your local cookie rules (e.g. UK PECR).
