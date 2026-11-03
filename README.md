# traffic-monitor

Central traffic monitoring for the `*.dliu.com` sites (S3/Lambda behind CloudFront).

- **Capture** – CloudFront standard logging (v2) delivers each site's access logs (with cookies, country and ASN)
  to one central S3 bucket. The deliveries live in a second stack, `TrafficLogDelivery`, in us-east-1.
- **Identify visitors** – a shared CloudFront Function (`dliu-visitor-id`, viewer-response) sets a first-party
  `dl_vid` cookie on `.dliu.com`, so the same visitor is recognised across all subdomains. It also writes the ID
  into the log line (`cf.logCustomData`), so a visitor's first request, sent before they had the cookie, counts under the same ID.
  When the site attaches the shared `dliu-traffic-geo` origin request policy, CloudFront adds `CloudFront-Viewer-City`
  and the function logs `<id>.<hex of the UTF-8 city>` (hex, because CloudFront escapes other characters in log fields).
  On HTML responses it sends `Accept-CH: Sec-CH-UA-Model, Sec-CH-UA-Platform-Version`, so Chrome-based browsers send
  their device model and real system version on later requests; the function validates them and logs
  `_m<hex model>_v<version>` after the ID and city. Safari and Firefox do not send client hints.
- **Page script (optional)** – a site can add `<script src="https://traffic.dliu.com/t/s.js" async></script>` to report
  how long each page view was on screen, how far it was scrolled, the screen size, load time and script errors. A CloudFront
  Function on the dashboard's `t/*` behavior (`functions/page-events.js`) serves the script and checks each report
  (`/t/e`, sent with `sendBeacon`): the site must be in `config/sites.json` and match the page's `Origin`. It logs
  `1.<view>.<n>.<site>.<dl_vid>.<seconds>.<scroll %>.<screen>.<load ms>.<errors>.<hex path>` and answers 204; nothing reaches
  an origin. The dashboard distribution's logs go to `events/YYYY/MM/DD/` as JSON (Glue table `page_events`), without
  cookies or query strings. The script sets no cookies; the existing `dl_vid` cookie is sent with the report.
- **Query** – a partitioner Lambda puts each file's columns in a fixed order and moves it into `logs/site=<site>/dt=<date>/`;
  Glue + Athena (partition projection) query them.
- **Dashboard** – `https://traffic.dliu.com`, private, Microsoft 365 (Entra ID) sign-in handled by the API Lambda (no Cognito).
  - `/` **All sites** – totals, visits over time, countries, a card per site (page views, visitors, IPs, last visit, sparkline) and the latest IP addresses.
  - `/site?site=<key>` **Site** – one site's chart, countries, top pages, referrers, IP addresses and request log.
  - `/page?site=<key>&path=<path>` **Page** – one page's views over time, how visitors arrived (WeChat Moments/chat/group
    from WeChat's `from=` share tag, else the referrer host or Direct), reading (time on screen and scroll depth, from the page script),
    its visitors, IP addresses and requests (click a page in Top pages). The page and request searches accept a full URL.
  - `/ip?ip=<address>` **IP** – everything one IP did across all sites (with its country, city and network), plus other IPs with the same `dl_vid`.
  - `/visitor?visitor=<dl_vid>` **Visitor** – everything one `dl_vid` visitor ID did across all sites: the IPs it used, the pages it viewed and its requests (click a visitor ID anywhere).
  - A country filter (`?country=GB`, or `unknown`) narrows the All sites, Site and Page pages; click a country in the Countries table to apply it.
  - `/bots` **Bots** (signed in) – bot records for the last 3 days or a custom range, with **Check bots now**;
    `/abuse-check` **AbuseIPDB check** (signed in) – lookups used per day, IPs waiting and what the lookups found.
  - Bots are left out of every widget by default; the All sites page always leaves them out. **Include bots** (on the Site and Page pages) adds them
    back, highlighted; the choice is kept in a `dl_dash_bots` cookie for a year and sent to the API as `bots=include`.
    The IP and Visitor pages always include them.
  - The period (1h, 12h, 24h, 7d, 30d, 90d, 1y, or a custom `YYYY-MM-DD HH:MM` period in local time, sent as UTC) is kept in the URL, so links can be shared and reloaded.
  - Every widget loads on its own (`/api/overview`, `/api/page`, `/api/ip` and `/api/visitor` take `part=`), with a spinner until its data arrives.
  - Tables are paged and searched in Athena through `/api/list`, so only the rows on screen are downloaded (at most 100 per call).
- **Docs** – `https://traffic.dliu.com/docs`, public, one page with tabs like the other dliu.com apps:
  Technical architecture `#architecture` (diagrams of the architecture and sign-in flow), Bot detection
  `#bot-detection` (the bot rules and checks), Cost `#cost` (the monthly bill and the cost per page load) and `#security` (threat model, live penetration-test results
  and accepted risks). The old `/about`, `/detect-bot`, `/cost` and `/security` URLs redirect (301) to their tab.
- **Chinese / English** – every page, the docs and the sign-in error page have the shared 中文 | English switch.

```
site CloudFront ──v2 logs──▶ S3 raw-v2/<site>/YYYY/MM/DD/ ──▶ partitioner λ ──▶ S3 logs/site=/dt=/ ◀── Athena ◀── dashboard λ ◀── traffic.dliu.com
        └─ viewer-response: dliu-visitor-id (sets dl_vid, logs it)
                                                              log merge λ (01:30 UTC) ──▶ S3 archive/month=/<site>_<day>.gz ◀── Athena
```

Cost at low traffic: about $0.26/month without dashboard use (S3 requests for ~350 log files a day, the daily public
stats, bot check and log merge); guests read pre-computed files for $0, and a signed-in dashboard page load costs about
$0.005 (mostly S3 lists and reads by Athena). See `/cost`.

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
2. Copy the **Application (client) ID** from *Overview*. The **Directory (tenant) ID** is shared by every dliu.com app:
   it lives in the SSM parameter `/dliu/entra-tenant-id`, owned by [dliu-com/audit](https://github.com/dliu-com/audit).
3. **Certificates & secrets → New client secret** — copy the secret **Value** (shown once).
4. **API permissions**: default `User.Read` → *Grant admin consent*.
5. **Enterprise applications → Traffic Monitor** → *Assignment required = Yes*, and assign the users who may sign in. Microsoft decides who gets in; note that Entra skips this check for Global Administrators. This is accepted (finding F7): Entra is the gate, and the app adds no object ID list or app role check.
6. Store the client ID and secret (prompted interactively, saved to SSM Parameter Store under `/traffic-monitor/`):

   ```bash
   make set-secrets
   ```

   The dashboard Lambda reads `/traffic-monitor/entra-client-id`, `/traffic-monitor/entra-client-secret` and the shared
   `/dliu/entra-tenant-id` at run time (cached 5 minutes); its role may read only those.

No secrets live in this repository. Besides verifying the Microsoft ID token (signature, tenant, audience, nonce, expiry), the dashboard only checks that the account's email is in the site's domain (`@dliu.com`, from the `MainDomain` export).
Renew the client secret before it expires and re-run `make set-secrets`.

## Adding a site

1. Add the site's key and host to `config/sites.json`, its CloudFront distribution ID to the gitignored
   `config/distributions.local.json` (format: `config/distributions.example.json`), and run `make deploy`;
   this creates its log delivery to `raw-v2/<site-key>/`.
   Add `"private": true` to keep the site out of the public figures guests see (no card, and not counted in the
   totals); signed-in use is unchanged.
2. In the site's CDK stack (same account/region), attach the visitor function and the city policy, and turn on
   cookie logging (without a legacy log bucket):

```js
const visitorId = cloudfront.Function.fromFunctionAttributes(this, 'VisitorId', {
  functionArn: cdk.Fn.importValue('TrafficVisitorFunctionArn'),
  functionName: 'dliu-visitor-id',
});
// Makes CloudFront add CloudFront-Viewer-City so the function can log the city (not in the cache key).
const trafficGeo = cloudfront.OriginRequestPolicy.fromOriginRequestPolicyId(
  this, 'TrafficGeo', cdk.Fn.importValue('TrafficGeoOriginRequestPolicyId'));

const distribution = new cloudfront.Distribution(this, 'Distribution', {
  // ...existing props
  defaultBehavior: {
    // ...existing props
    originRequestPolicy: trafficGeo, // only if the behavior has no origin request policy yet
    functionAssociations: [
      // ...existing associations
      { eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE, function: visitorId },
    ],
  },
});
// Cookie logging for standard logging (v2); no legacy log bucket. The partitioner keeps only dl_vid.
(distribution.node.defaultChild as cloudfront.CfnDistribution)
  .addPropertyOverride('DistributionConfig.Logging', { IncludeCookies: true });
```

Deploy `TrafficMonitor` before any site; it can't be deleted while sites import its exports.

3. Optionally, for time on page and scroll depth, load the page script on every page and allow it in the CSP
   (`script-src https://traffic.dliu.com/t/s.js` and `connect-src https://traffic.dliu.com/t/e`). The same script
   serves every site; reports are kept only for hosts in `config/sites.json` sent from that host's pages. `async`
   never delays the page; if traffic.dliu.com hangs, only the browser's loading bar waits.

```html
<script src="https://traffic.dliu.com/t/s.js" async></script>
```

## Look (shared dliu.com UI)

The dashboard uses the shared dliu.com look ([spec](https://files.dliu.com/dliu.com/README.md)): every page in `web/`
loads `https://files.dliu.com/dliu.com/ui/v1/dl.css` first (the docs page `/docs`, with the shared tab names Technical architecture,
Bot detection, Cost and Security, also loads `dl-docs.css` and uses `dl-tabs`), and has the shared header and footer. Top left is the app's
logo and name ("DL Traffic"; `web/logo.svg`, a white bar chart on the DL blue #209cee, is also the favicon), and
the footer starts with the shared DL logo.
On phones the dashboard pages fold their links into a ☰ menu (`dl-menu-toggle`, opened by `web/dash.js`).
The shared Chinese/English switch (`dl-language`) is added last in the header nav, inside the ☰ menu, by `web/i18n.js`,
which every page loads first (as on blog.dliu.com): a choice saved in the browser (`localStorage` key `traffic-language`)
wins, otherwise any `zh-*` browser language means Chinese and anything else English. Switching saves the choice and
reloads the page. Fixed HTML text carries its Chinese in `data-zh` (and `data-zh-label` for aria-labels); scripts write
their text with `t('中文', 'English')`. Data from the logs is never translated.
Buttons, the period switch (`dl-segmented`), cards, tables and the Microsoft sign-in button use the shared `dl-*`
classes; `web/style.css` keeps only the dashboard's own parts (KPIs, charts, site cards, filters) on the shared
`--dl-*` colours. Light theme only. The CSP allows only `https://files.dliu.com/dliu.com/ui/` for styles and
`https://files.dliu.com/dliu.com/` for the icon. `test/shared-ui.test.js` guards this.

## Caching and clearing (traffic.dliu.com)

The dashboard distribution uses every edge location and HTTP/3. What CloudFront keeps, and how a change reaches visitors:

| Files | Browser | CloudFront | Cleared by |
| --- | --- | --- | --- |
| HTML pages | `no-cache` (asks every time) | revalidated on each request | — |
| JS, CSS, images (`web/`) | `max-age=0, must-revalidate` | 1 day (`s-maxage=86400`) | `make deploy` (`/*`) |
| `stats/*.json` (public totals) | 5 minutes (`max-age=300`) | 1 day (`s-maxage=86400`) | automatic clearing (below) |
| `/api/*`, `/auth/*` | not cached | not cached | — |
| `/t/*` (page script, events) | answered by a CloudFront Function | — | — |

Automatic clearing is on for **`stats/` in the dashboard bucket only**, the one prefix the app rewrites outside a
deploy. Its only writer, the `PublicStats` Lambda (daily at 02:00 UTC, after `make deploy` and with
`make public-stats`), creates one `/stats/*` invalidation after writing all the files: one path a run, about 30 a
month of the 1,000 free paths shared by all sites. It may only create invalidations on this distribution. If the
invalidation fails the run fails (the schedule retries once) and CloudFront keeps the old copy for at most a day.
S3 event notifications (EventBridge, SQS) were tried and dropped: an idle SQS poller makes hundreds of thousands of
requests a month, one event per file cost three paths a run, and with a single writer they add nothing. Editing or
deleting `stats/` files by hand is not cleared; run `make public-stats` instead.

Not cleared automatically, and why:

- Web files (HTML, JS, CSS): change only with a deploy, which already clears `/*`.
- Log bucket (`raw/`, `raw-v2/`, `logs/`, `archive/`, `events/`, bot and reputation data): not served by CloudFront,
  and new files are added constantly; a file that was never cached needs no clearing.
- `/api/*`, `/auth/*` and `/t/*`: never cached.

## Security tests

Rerunnable live checks against production (results and the threat model: [traffic.dliu.com/docs](https://traffic.dliu.com/docs), Security tab).
Each prints `PASS|FAIL <test> | expected <x> | actual <y>` and exits with the number of failures. Run from the repo root.

```sh
bash scripts/pentest/unauth.sh                 # black box, no account needed except the AWS CLI for the direct-origin tests
AWS_REGION=eu-west-1 node scripts/pentest/auth.js   # signed in: mints a 10-minute test session from the SSM secret
bash scripts/pentest/beacon.sh send            # /t/e reports; prints a run id
bash scripts/pentest/beacon.sh verify <run>    # about 10 minutes later: checks in Athena what was logged
node scripts/pentest/auth.js --seed            # stored XSS: logs script payloads as a test visitor
AWS_REGION=eu-west-1 node scripts/pentest/auth.js --xss  # about 10 minutes later: the API returns them as data
```

After `--xss`, open the printed visitor page signed in: no alert may appear and no `<img>`/`<script>` from the payload may be in the page.

## Cost alert

The account-wide daily AWS budget (`account-daily-spending`, $10 a day) and its alert topic live in
[dliu-com/audit](https://github.com/dliu-com/audit) (its README, "Cost alert"), with the other account-wide resources
that belong to no single app. It covers this app's spend too. It warns; it stops nothing.

## Notes

- Visitors are identified by the `dl_vid` cookie sent; a request without one uses the ID the function logged if that ID
  later came back as a cookie in the queried period (so cookie-less bots don't count once per request), then `ip:<address>`
  (bots and cookie-blocking browsers). Responses the function does not run on (e.g. some origin errors) use the cookie.
- A request is a bot if its user agent is empty, `-`, or looks like a crawler or script (checked in every query), or if
  the bot check (every 6 hours) flagged its IP for that UTC day. CloudFront itself doesn't flag bots. Visitor IDs are worked out
  before bots are dropped. Rules and quota handling are documented at `/docs#bot-detection` (`web/docs-bot-detection.js`).
- The `BotClassifier` Lambda (`lambda/dashboard/bots.js`) runs every 6 hours (00:30, 06:30, 12:30 and 18:30 UTC), after
  `make deploy`, from the dashboard's "Check bots now" button or with `make classify-bots DAYS=N` (default 3, up to 7). It
  covers today and the DAYS days before; a scheduled run skips while another is going. It reads only log files no earlier
  run has read and adds them to running counts per day and IP in `bot-state/dt=<day>.json` (`lambda/dashboard/bot-state.js`,
  kept 7 days), so no log record is read twice and no Athena query is needed. For each day and IP it picks the first matching reason: `hosting` (ASN on the hosting list), `probe` (asked for paths like
  `/.env` or `wp-login`), `abuse` (AbuseIPDB score ≥ 50, Tor, or data centre) or `headless` (no script, stylesheet,
  font or `dl_vid` cookie all day). Verdicts go to `bots/dt=<day>/bots.json` (Glue table `bot_ips`).
- AbuseIPDB (free plan, 1,000 lookups a day): store the key with `make set-abuseipdb-key` (SSM SecureString
  `/traffic-monitor/abuseipdb-api-key`). Only IPs that still look like people are looked up, each once per 30 days
  across all runs, newest day and busiest first. The day's runs share the 1,000 lookups (counted from
  `abuseipdb/runs/`); a run stops at HTTP 429 or when none are left, and the rest wait for a later run. Results go to
  `reputation/dt=<day>/` (table `ip_reputation`) for 180 days, and the latest per IP to `bot-state/reputation.json`.
  Only the IP is sent. Without a key every other rule still runs.
- The `LogMerge` Lambda (`lambda/dashboard/compact.js`) runs at 01:30 UTC. Once the bot check has finished with a day
  (4 days old), it merges each site's files for that day into `archive/month=<YYYY-MM>/<site>_<day>.gz` (Glue table
  `cloudfront_logs_archive`, partitioned by month; `site` and `dt` are columns), deletes the bots' requests for good
  and then deletes the daily files. So the newest 3 days (plus today) hold every request, older days people only.
  Athena pays for each folder it lists and file it reads, so a 90-day query lists about 4 month folders instead of
  720 day folders. Queries read daily folders for the last 7 days and the archive for older days.
  `make compact-logs FROM=YYYY-MM-DD TO=YYYY-MM-DD` merges older days once (`DRY=1` reports only; `UNJUDGED=1` also
  merges days from before the bot check, dropping agent bots only).
- The hosting network list (`lambda/dashboard/hosting.js`, about 950 ASNs) is a built-in core (AWS, Google, Azure,
  Oracle, DigitalOcean, OVH, Hetzner, Censys…) plus two public lists, [brianhama/bad-asn-list](https://github.com/brianhama/bad-asn-list)
  and [X4BNet/lists_vpn](https://github.com/X4BNet/lists_vpn) (datacenter ASNs). The `HostingListUpdater` Lambda
  downloads them every Monday 04:00 UTC (and after `make deploy`; run it any time with `make update-hosting`),
  validates and merges them, and saves `hosting/asns.json` in the log bucket, which the bot check reads. A source that fails or looks too small
  is skipped, and if the merged list looks wrong nothing is written, so the last copy stays. The dashboard reads the
  copy at most hourly and falls back to the built-in core. Networks that also carry people (Cloudflare WARP, iCloud
  Private Relay via Akamai, Fastly and Apple) are excluded in code and always win. People on commercial VPNs count as bots.
  Because the log merge deletes bots' requests for good, a poisoned list must not reach home users: a source that
  names one of about 60 big home broadband or mobile networks (`CONSUMER` in hosting.js; Comcast, BT, China Telecom…)
  is skipped, those networks are never hosting, and an update that would add more than 300 networks to the last copy
  is refused. After checking such a change, run the updater once with the payload `{"force":true}`.
- Country and ASN come from CloudFront itself; requests before the switch to v2 (about 21:00 UTC on 9 Oct 2026)
  have none. City comes from CloudFront too, from about 13:30 UTC on 12 Oct 2026, and only on requests the visitor
  function runs on (not `/api/*` behaviors, nor link.dliu.com, whose viewer-request function answers every request).
  Queries keep a city only if it decodes to letters, digits, spaces and `.'’(),-` (at most 60 characters).
- City fill-in (`lambda/dashboard/geo.js`): the `CityDatabaseUpdater` Lambda downloads [DB-IP](https://db-ip.com)'s free
  IP to City Lite database (CC BY 4.0, about 60 MB gzipped, 130 MB unpacked) on the 2nd–4th of each month (and after
  `make deploy`; run it with `make update-cities`), checks it and saves it to `geodb/` in the log bucket. Each bot check
  looks up, in memory, the IPs CloudFront gave no city that day and keeps DB-IP's city only if DB-IP agrees on the
  country; results go to `cities/dt=<day>/cities.json` (Glue table `ip_cities`, kept like the logs). The dashboard
  shows them as `Nanjing (DB-IP)`. The `.mmdb` reader is built in, so the Lambdas still have no npm dependencies.
  IP Geolocation by DB-IP, credited on the Docs page.
- Legacy logs (`raw/<site>/`) are filed only up to `LEGACY_LAST_HOUR` in `lambda/partitioner/index.js`; later ones
  are deleted, since v2 already has those requests. The overlap hour was cleaned with
  `node scripts/dedupe-overlap.js --bucket <log bucket>`, which drops legacy rows whose request ID is also in a v2 file.
- CloudFront logs the whole Cookie header, including the sites' sign-in session cookies, and the full query string and
  referrer, which can hold share tokens (plan's `?token=`) and OAuth `code`/`state`. Before filing a log the
  partitioner keeps only `dl_vid=<id>` in `cs(Cookie)` and replaces secret query values (token, code, state, keys,
  signatures, passwords…) with `redacted` in `cs-uri-query` and `cs(Referer)`; the names stay, and nothing reads the
  values. It then deletes the raw file, so raw logs live only seconds. Logs filed before this were rewritten with
  `node scripts/redact-logs.js --bucket <log bucket>` (safe to rerun; `--dry-run` only counts).
- CloudFront logs arrive with a delay of a few minutes.
- status.dliu.com probes every site as a guest every 15 minutes with the user agent `dliu-status-bot/1.0`. The
  partitioner drops every log line whose (URL-decoded) user agent starts with `dliu-status-bot/`, so the probes never
  reach the Bots page, Athena scans, the bot check or AbuseIPDB; a file holding only probes is not filed at all.
- Logs are kept for 1 year; a raw (unpartitioned) file left by a failed partitioner run expires after 1 day.
- Every CloudWatch log group (the app's Lambdas and CDK's helper Lambdas) keeps logs for 90 days.
- The `dl_vid` cookie is set without a consent banner; consider your local cookie rules (e.g. UK PECR).
