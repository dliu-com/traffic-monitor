import { flow, tiers, stats, cards, more } from './diagram.js';
import { t } from './i18n.js';

const root = document.getElementById('architecture');

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
  [t('0 台服务器', '0 servers'), t('无人访问时不运行任何服务器', 'running while nobody visits'), 'power'],
  [t('< $1 / 月', '< $1 / month'), t('所有网站合计', 'for all sites together'), 'budget'],
  [t('≈ 5 分钟', '≈ 5 min'), t('从访问到出现在仪表板', 'from visit to dashboard'), 'clock'],
  [t('1 年', '1 year'), t('的请求历史', 'of request history'), 'chart'],
]));

section(t('技术架构', 'Technical architecture'));
root.append(tiers({
  title: t('系统总览', 'System map'),
  rows: [
    {
      label: t('访客', 'Visitors'), badge: t('互联网', 'Internet'), tone: 'untrusted',
      nodes: [
        { icon: 'browser', title: t('浏览器', 'Browsers'), text: t('访问任一 dliu.com 网站的人', 'People visiting any dliu.com site') },
        { icon: 'bot', title: t('机器人', 'Bots'), text: t('爬虫、扫描器和来自云主机的流量，由每 6 小时一次的检查标记，除非选择包含，否则不显示', 'Crawlers, scanners and cloud-hosted traffic, flagged by a check every 6 hours and hidden unless you include them') },
      ],
    },
    {
      label: t('各网站', 'Each site'), badge: t('边缘', 'Edge'), tone: 'edge', link: t('每次请求', 'every request'),
      nodes: [
        { icon: 'cloudfront', title: 'CloudFront', text: t('从 S3 或 Lambda 提供网站内容，并为每次请求写一行日志，包含访客所在国家/地区', 'Serves the site from S3 or Lambda and writes a log line per request, with the visitor’s country') },
        { icon: 'cookie', title: t('访客 ID 函数', 'Visitor ID function'), text: t('共享的 CloudFront Function，设置 dl_vid cookie 并把 ID 写入日志', 'Shared CloudFront Function that sets the dl_vid cookie and writes the ID into the log') },
      ],
    },
    {
      label: t('日志管道', 'Log pipeline'), badge: t('私有', 'Private'), tone: 'private', link: t('日志文件，几分钟后送达', 'log files, a few minutes later'),
      nodes: [
        { icon: 's3', title: t('日志存储桶', 'Log bucket'), text: t('先到 raw-v2/<site>/，再到 logs/site=<site>/dt=<day>/，最后归入 archive/month=<YYYY-MM>/', 'raw-v2/<site>/, then logs/site=<site>/dt=<day>/, then archive/month=<YYYY-MM>/') },
        { icon: 'lambda', title: t('分区器', 'Partitioner'), text: t('把每个新日志文件的列按固定顺序排列，并按网站和日期归档', 'Puts each new log file’s columns in a fixed order and files it by site and day') },
        { icon: 'glue', title: t('Glue 表', 'Glue table'), text: t('描述日志的列和分区', 'Describes the log columns and partitions') },
      ],
    },
    {
      label: t('仪表板', 'Dashboard'), badge: t('应用', 'App'), tone: 'app', link: t('按需查询', 'queried on demand'),
      nodes: [
        { icon: 'cloudfront', title: 'traffic.dliu.com', text: t('静态页面来自 S3；/api 和 /auth 转发到 Lambda', 'Static pages from S3; /api and /auth go to Lambda') },
        { icon: 'lambda', title: t('仪表板 Lambda', 'Dashboard Lambda'), text: t('Microsoft 登录和 Athena 查询', 'Microsoft sign-in and Athena queries') },
        { icon: 'athena', title: 'Athena', text: t('用 SQL 查询日志，只读取所选的网站和日期', 'SQL over the logs, reading only the chosen sites and days') },
      ],
    },
  ],
  note: t('各网站只需挂上共享函数；它们的 CloudFront 日志投递由监控系统配置（标准日志 v2，创建在 us-east-1）。网站从不调用监控系统，因此监控系统永远不会拖慢网站，也不会导致网站下线。', 'The sites only attach the shared function; the monitor sets up their CloudFront log delivery (standard logging v2, created in us-east-1). The sites never call the monitor, so it can never slow a site down or take it offline.'),
}));

root.append(flow({
  title: t('一次请求的经历', 'Life of one request'),
  numbered: true,
  steps: [
    { icon: 'browser', title: t('访问', 'Visit'), text: t('浏览器请求页面、文件或 API', 'A browser requests a page, file or API call') },
    { icon: 'cloudfront', title: t('响应', 'Serve'), text: t('CloudFront 从缓存、S3 或 Lambda 返回内容', 'CloudFront answers from cache, S3 or Lambda') },
    { icon: 'cookie', title: t('标记', 'Tag'), text: t('浏览器没有 dl_vid 时添加一个，无论有没有都会记入日志', 'dl_vid is added if the browser has none, and logged either way') },
    { icon: 's3', title: t('记录', 'Log'), text: t('CloudFront 把日志文件投递到 raw-v2/<site>/', 'CloudFront delivers the log file to raw-v2/<site>/') },
    { icon: 'lambda', title: t('整理', 'Sort'), text: t('分区器按网站和日期归档', 'The partitioner files it by site and day') },
    { icon: 'chart', title: t('展示', 'Show'), text: t('仪表板加载时由 Athena 读取', 'Athena reads it when the dashboard loads') },
  ],
  note: t('经 CloudFront 转发到 Lambda 的请求（例如围棋网站的 API）与静态文件一样会被记录。', 'Requests that go to a Lambda behind CloudFront, such as the Weiqi API, are logged the same way as static files.'),
}));

section(t('记录哪些内容', 'What is recorded'));
list([
  [t('时间', 'Time'), t('CloudFront 收到请求的时间（UTC，按你的时区显示）', 'when CloudFront received the request (UTC, shown in your time zone)')],
  [t('IP 地址', 'IP address'), t('请求来源地址', 'the address the request came from')],
  [t('国家/地区、城市和网络', 'Country, city and network'), t('CloudFront 判定该 IP 所在的国家/地区、城市和网络（ASN）；城市只是大致位置，CloudFront 未给出城市时，显示 DB-IP 的城市，格式为“城市 (DB-IP)”', 'the country, city and network (ASN) CloudFront places the IP in; the city is approximate, and where CloudFront gives none, DB-IP’s city is shown as “City (DB-IP)”')],
  [t('访客', 'Visitor'), t('dl_vid ID；没有时（机器人和屏蔽 cookie 的浏览器）用 IP 地址代替', 'the dl_vid ID, or the IP address when there is none (bots and cookie-blocking browsers)')],
  [t('请求', 'Request'), t('网站、方法、路径、查询字符串、状态码和发送的字节数', 'site, method, path, query string, status code and bytes sent')],
  [t('浏览器和设备', 'Browser and device'), t('User-Agent 和来源页（referrer），用于显示浏览器和设备，并识别机器人和外部链接', 'user agent and referrer, used to show the browser and device and to spot bots and external links')],
]);

root.append(flow({
  title: t('识别同一访客', 'Recognising the same visitor'),
  steps: [
    { icon: 'user', title: t('首次访问', 'First visit'), text: t('浏览器还没有 dl_vid cookie', 'The browser has no dl_vid cookie') },
    { icon: 'cookie', title: t('设置 cookie', 'Cookie set'), text: t('在 .dliu.com 上设置一个随机 ID，保留一年，并写入该请求的日志行', 'A random ID on .dliu.com, kept for one year, and written into that request’s log line') },
    { icon: 'link', title: t('所有网站', 'Every site'), text: t('浏览器会把它发送给所有 dliu.com 子域名', 'The browser sends it to all dliu.com subdomains') },
    { icon: 'eye', title: t('归并', 'Grouped'), text: t('仪表板按 dl_vid 统计请求', 'The dashboard counts requests per dl_vid'), tone: 'good' },
  ],
  note: t('该 cookie 为 HttpOnly，只包含一个随机 ID，从不包含个人数据。由于函数会把它设置的 ID 写入日志，即使是第一次请求也会计入该 ID。屏蔽 cookie 的浏览器和大多数机器人每次都会得到新 ID，因此改按 IP 地址统计。', 'The cookie is HttpOnly and holds only a random ID, never personal data. Because the function logs the ID it sets, even the very first request is counted under it. Cookie-blocking browsers and most bots get a new ID each time, so they are counted by IP address instead.'),
}));

section(t('身份验证', 'Authentication'), t('仪表板是私有的。每次 API 调用都需要一个签名会话，而这个会话只能通过使用 dliu.com 目录中的 Microsoft 工作账号登录获得。“关于”和“安全”页面是公开的。', 'The dashboard is private. Every API call needs a signed session that can only be obtained by signing in with a Microsoft work account in the dliu.com directory. The About and Security pages are public.'));

root.append(flow({
  title: t('登录流程', 'Signing in'),
  numbered: true,
  steps: [
    { icon: 'browser', title: t('登录', 'Sign in'), text: t('/auth/login 生成 state、nonce 和 PKCE 码', '/auth/login creates state, nonce and a PKCE code') },
    { icon: 'entra', title: 'Microsoft', text: t('由 Entra 完成登录；只有已分配的用户能通过', 'Entra signs you in; only assigned users get through') },
    { icon: 'key', title: t('验证', 'Verify'), text: t('Lambda 校验 ID 令牌的签名和声明', 'The Lambda checks the ID token signature and claims') },
    { icon: 'shield', title: t('域名', 'Domain'), text: t('账号必须是 @dliu.com 用户', 'The account must be an @dliu.com user') },
    { icon: 'lock', title: t('会话', 'Session'), text: t('签名 cookie，有效期 12 小时', 'A signed cookie, valid for 12 hours'), tone: 'good' },
  ],
  note: t('客户端密钥保存在 SSM Parameter Store 中，而不是代码里。携带 state、nonce 和 PKCE 的登录 cookie 10 分钟后过期。', 'The client secret lives in SSM Parameter Store, not in the code. The sign-in cookie that carries state, nonce and PKCE expires after 10 minutes.'),
}));

section(t('运行成本', 'Running costs'), t('无人访问时没有任何东西在运行，因此没有固定的服务器费用。各部分都按使用量计费：记录所有网站和每日任务每月约 $0.26，未登录的游客浏览不产生费用（读取的是预先计算好的文件），已登录用户每加载一次仪表板页面约 $0.005。完整明细见“成本”页面。', 'Nothing runs while nobody is visiting, so there is no fixed server fee. Every part is billed per use: about $0.26 a month for recording all sites and the daily jobs, nothing for guest visits (they read pre-computed files), and about $0.005 per signed-in dashboard page load. The Running costs page has the full breakdown.'));

section(t('安全', 'Security'), t('监控系统存储的数据由访客控制，例如浏览器名称和他们输入的地址，因此每个记录下来的值都被视为恶意输入。它们在仪表板上只以纯文本显示，从不拼入 SQL。本网站于 2026 年 10 月 9 日完成了威胁建模和渗透测试，发现的四个问题已在当天修复。', 'The monitor stores data that visitors control, such as their browser name and the address they typed, so every logged value is treated as hostile. It is shown on the dashboard as plain text and never placed into SQL. The site was threat-modelled and penetration-tested on 9 October 2026; the four issues found were fixed the same day.'));

root.append(tiers({
  title: t('多层防护', 'Layers of protection'),
  rows: [
    {
      label: 'Microsoft Entra', badge: t('身份', 'Identity'), tone: 'edge',
      nodes: [
        { icon: 'entra', title: t('单租户', 'Single tenant'), text: t('只有 dliu.com 目录中的账号可以登录', 'Only accounts in the dliu.com directory can sign in') },
        { icon: 'users', title: t('需要分配', 'Assignment required'), text: t('只有分配到该应用的用户（全局管理员除外）', 'Only users assigned to the app (Global Administrators are exempt)') },
      ],
    },
    {
      label: t('仪表板 Lambda', 'Dashboard Lambda'), badge: t('校验', 'Checks'), tone: 'private', link: t('ID 令牌', 'ID token'),
      nodes: [
        { icon: 'key', title: t('令牌校验', 'Token checks'), text: t('签名、颁发者、租户、受众、nonce 和过期时间', 'Signature, issuer, tenant, audience, nonce and expiry') },
        { icon: 'shield', title: t('域名校验', 'Domain check'), text: t('用户名或邮箱必须以 @dliu.com 结尾', 'Username or email must end in @dliu.com') },
        { icon: 'lock', title: t('会话 cookie', 'Session cookie'), text: t('HMAC 签名、HttpOnly、Secure、SameSite=Lax', 'HMAC-signed, HttpOnly, Secure, SameSite=Lax') },
      ],
    },
    {
      label: t('浏览器和 AWS', 'Browser and AWS'), badge: t('基础设施', 'Infra'), tone: 'app', link: t('每次请求', 'every request'),
      nodes: [
        { icon: 'code', title: t('杜绝脚本注入', 'No script injection'), text: t('值以文本显示；CSP 只允许本站自己的脚本', 'Values shown as text; CSP allows only the site’s own scripts') },
        { icon: 'cloudfront', title: t('仅限 CloudFront', 'CloudFront only'), text: t('Lambda URL 和 S3 存储桶只接受来自 CloudFront 的请求', 'The Lambda URL and S3 buckets accept requests from CloudFront alone') },
        { icon: 'filter', title: t('固定查询', 'Fixed queries'), text: t('筛选条件经过校验；不允许用户编写 SQL', 'Filters are validated; no user-written SQL') },
        { icon: 'budget', title: t('扫描上限', 'Scan limit'), text: t('每次 Athena 查询扫描满 1 GB 即停止', 'Each Athena query stops at 1 GB scanned') },
      ],
    },
  ],
}));

section(t('延伸阅读', 'Read more'));
root.append(cards([
  ['/docs#bot-detection', 'bot', t('机器人识别', 'Bot detection'), t('区分机器人和真人的规则，以及每 6 小时一次的检查', 'The rules that tell bots from people, and the check every 6 hours'), t('5 条规则 · AbuseIPDB · 每 6 小时', '5 rules · AbuseIPDB · every 6 hours')],
  ['/docs#cost', 'budget', t('运行成本', 'Running costs'), t('各部分每月和每次页面加载的费用，以及原因', 'What each part costs, per month and per page load, and why'), t('每月 ≈ $0.26 · 游客免费', '≈ $0.26 a month · guests free')],
  ['/docs#security', 'shield', t('安全评估', 'Security review'), t('线上渗透测试、威胁模型和已接受的风险', 'Live penetration test, threat model and accepted risks'), t('21 项测试，4 处修复 · 2026 年 10 月 9 日', '21 tests, 4 fixes · 9 Oct 2026')],
  ['https://github.com/dliu-com/traffic-monitor', 'code', t('源代码', 'Source code'), t('CDK 栈、Lambda、函数以及这些页面', 'The CDK stack, Lambdas, functions and these pages'), t('在 GitHub 上公开', 'Public on GitHub')],
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
detailList(t('组件', 'Components'), [
  t('两个 AWS CDK 栈（TypeScript）：位于 eu-west-1 的 TrafficMonitor，以及位于 us-east-1 的 TrafficLogDelivery（CloudFront 日志投递必须建在这里）。各网站自己的栈只需挂上共享函数和源请求策略，并保持开启 cookie 记录。', 'Two AWS CDK stacks (TypeScript): TrafficMonitor in eu-west-1, and TrafficLogDelivery in us-east-1, where CloudFront log deliveries must live. Each site’s own stack only attaches the shared function and origin request policy, and keeps cookie logging on.'),
  t('城市：共享的源请求策略 dliu-traffic-geo 挂在各网站的默认行为上，让 CloudFront 添加 CloudFront-Viewer-City 请求头。访客函数把它记录为 <id>.<UTF-8 名称的十六进制>，因为 CloudFront 会转义日志字段中的其他字符。该请求头不属于缓存键，因此缓存不受影响。', 'City: the shared origin request policy dliu-traffic-geo, on each site’s default behavior, makes CloudFront add its CloudFront-Viewer-City header. The visitor function logs it as <id>.<hex of the UTF-8 name>, since CloudFront escapes other characters in log fields. The header is not part of the cache key, so caching is unchanged.'),
  t('客户端提示：访客函数在 HTML 响应中添加 Accept-CH: Sec-CH-UA-Model, Sec-CH-UA-Platform-Version。之后基于 Chrome 的浏览器会在后续请求中发送设备型号和真实系统版本；函数只保留符合严格格式的值，并以 _m<型号的十六进制>_v<版本> 的形式记录在 ID 和城市之后。', 'Client hints: on HTML responses the visitor function adds Accept-CH: Sec-CH-UA-Model, Sec-CH-UA-Platform-Version. Chrome-based browsers then send their device model and real system version with later requests; the function keeps them only if they match a strict pattern and logs them after the ID and city as _m<hex model>_v<version>.'),
  t('访客 ID：一个在 viewer response 阶段运行的 CloudFront Function（cloudfront-js-2.0），在 .dliu.com 上设置有效期一年的 dl_vid，并用 cf.logCustomData 把 ID 写入日志；网站转发了访客城市时，城市紧随其后。', 'Visitor ID: a CloudFront Function (cloudfront-js-2.0) on viewer response that sets dl_vid on .dliu.com for one year and writes the ID into the log with cf.logCustomData, followed by the viewer’s city when the site forwards it.'),
  t('日志投递：为每个网站的分发配置 CloudFront 标准日志（v2），把 36 个制表符分隔的字段（33 个经典字段加上 c-country、asn 和 viewer-response-log-data）写入 raw-v2/<site>/YYYY/MM/DD/。', 'Log delivery: CloudFront standard logging (v2) for each site’s distribution, writing 36 tab-separated fields (the 33 classic ones plus c-country, asn and viewer-response-log-data) to raw-v2/<site>/YYYY/MM/DD/.'),
  t('日志存储桶：分区器 Lambda（Node.js）按每个文件的 #Fields 头重排列，只保留 dl_vid Cookie，把查询参数和来源页中的机密值（令牌、OAuth code 等）替换为 redacted，gzip 压缩后写入 logs/site=<site>/dt=<day>/，并删除原始文件。只有本账号的日志投递服务可以写入 raw-v2/。每天 01:30 UTC，日志合并任务会把机器人检查已处理完的每一天（4 天前）合并为 archive/month=<YYYY-MM>/ 中每个网站一个文件，去掉机器人的请求，并删除当天的文件；仪表板从每日文件夹读取最近 7 天，从月份文件夹读取更早的日期。', 'Log bucket: the partitioner Lambda (Node.js) reorders each file’s columns by its #Fields header, keeps only the dl_vid cookie, replaces secret values (tokens, OAuth codes…) in the query and referrer with redacted, gzips it into logs/site=<site>/dt=<day>/ and deletes the raw file. Only the log delivery service of this account may write to raw-v2/. At 01:30 UTC the log merge turns each day the bot check has finished with (4 days old) into one file per site in archive/month=<YYYY-MM>/, without the bots\' requests, and deletes that day\'s files; the dashboard reads the last 7 days from the daily folders and older days from the month folders.'),
  t('Glue 表 cloudfront_logs（按网站和日期做分区投影）和 cloudfront_logs_archive（按月份），因此不需要爬网程序，也不需要更新分区。', 'Glue tables cloudfront_logs (partition projection over site and day) and cloudfront_logs_archive (over month), so no crawler or partition updates are needed.'),
  t('Athena 工作组 traffic，强制 1 GB 扫描上限，并复用 5 分钟内的查询结果。', 'Athena workgroup traffic with an enforced 1 GB scan cutoff and 5-minute result reuse.'),
  t('机器人检查：一个 Node.js Lambda，由 EventBridge 每 6 小时触发一次，也可从仪表板手动运行。它只读取之前任何一次运行都没读过的日志文件（累计计数保存在 bot-state/ 中），并把每日的机器人判定和 AbuseIPDB 结果写入日志存储桶，通过另外两张 Glue 表读取。', 'Bot check: a Node.js Lambda run every 6 hours by EventBridge, or from the dashboard, reads only log files no earlier run has read (keeping running counts in bot-state/) and writes per-day bot verdicts and AbuseIPDB results to the log bucket, read through two more Glue tables.'),
  t('城市补全：每月 2 日，一个 Lambda 把 DB-IP 免费的 IP to City Lite 数据库（约 60 MB，解压后 130 MB）下载到日志存储桶的 geodb/ 中。随后机器人检查会在内存中查找当天 CloudFront 未给出城市的每个 IP，只有当 DB-IP 判定的国家/地区与 CloudFront 一致时，才采用 DB-IP 的城市。结果写入 cities/dt=<day>/（Glue 表 ip_cities）。IP 不会发送到任何地方。', 'City fill-in: on the 2nd of each month a Lambda downloads DB-IP’s free IP to City Lite database (about 60 MB, 130 MB unpacked) to geodb/ in the log bucket. The bot check then looks up, in memory, each IP CloudFront gave no city that day and keeps DB-IP’s city only when DB-IP places the IP in the same country as CloudFront. Results go to cities/dt=<day>/ (Glue table ip_cities). No IP is sent anywhere.'),
  t('仪表板：静态 HTML、CSS 和 JavaScript 存放在 CloudFront 后面的私有 S3 存储桶中；/api/* 和 /auth/* 转发到一个 Node.js Lambda 函数 URL，由 IAM 和源访问控制保护。', 'Dashboard: static HTML, CSS and JavaScript in a private S3 bucket behind CloudFront; /api/* and /auth/* go to a Node.js Lambda function URL secured with IAM and origin access control.'),
]);
detailList(t('数据和保留期限', 'Data and retention'), [
  t('每行日志有 36 个字段；仪表板使用其中的时间、IP、国家/地区、城市、网络（ASN）、网站、方法、路径、查询字符串、状态码、字节数、User-Agent、来源页和 dl_vid ID。', 'Each log line has 36 fields; the dashboard uses time, IP, country, city, network (ASN), site, method, path, query, status, bytes, user agent, referrer and the dl_vid ID.'),
  t('“浏览器”和“设备”两列根据 User-Agent 解析（鼠标悬停可查看完整内容）。“浏览器”是浏览器或应用内浏览器（微信、QQ、Facebook……）及其版本。“设备”是设备类型（iPhone、iPad、手机、平板、桌面或电视）、User-Agent 中写明的 Android 型号（应用内浏览器和旧版浏览器会写明；Chrome 只发送“K”）以及系统版本。iPhone 从不透露具体型号，有些版本号是冻结的，因此不显示：macOS 始终显示 10.15.7，Windows 10 和 11 看起来一样，Android 上的 Chrome 始终显示 Android 10。从 2026 年 11 月 1 日起，访客函数会在每个 HTML 页面上向基于 Chrome 的浏览器请求客户端提示，这些浏览器从下一次请求起会发送真实的型号和系统版本（例如“Phone · SM-S918B · Android 14”“Desktop · Windows 11”），“设备”列随后会使用这些信息。访客打开的第一个页面没有提示，Safari 和 Firefox 则从不发送。', 'The Browser and Device columns are read from the user agent (hover for all of it). Browser is the browser or in-app browser (WeChat, QQ, Facebook…) and its version. Device is the kind of device (iPhone, iPad, phone, tablet, desktop or TV), the Android model when the user agent names one (in-app browsers and older browsers do; Chrome sends only “K”) and the system version. An iPhone never says which model it is, and some versions are frozen and left out: macOS always says 10.15.7, Windows 10 and 11 look the same, and Chrome on Android always says Android 10. From 1 November 2026 the visitor function asks Chrome-based browsers for client hints on every HTML page, and from their next request they send their real model and system version (e.g. “Phone · SM-S918B · Android 14”, “Desktop · Windows 11”), which the Device column then uses. The first page a visitor opens has no hints, and Safari and Firefox never send them.'),
  t('国家/地区来自 CloudFront 自己的 IP 查询，因此无需更新地理位置数据库。2026 年 10 月 9 日约 21:00 UTC 各网站切换到这种日志格式之前记录的请求没有国家/地区信息，显示为“未知”。城市从 2026 年 10 月 12 日约 13:30 UTC 开始记录，且只针对访客函数会运行的请求（不包括 /api 调用，也不包括 link.dliu.com，它的重定向在函数运行前就已返回），另外 CloudFront 对某些 IP 也没有城市信息。某个 IP 当天没有 CloudFront 城市时，若 DB-IP 判定的国家/地区一致，则采用 DB-IP 数据库中的城市，显示为“Nanjing (DB-IP)”；DB-IP 精度较低，仍有部分 IP 没有城市。', 'Country comes from CloudFront’s own IP lookup, so there is no geolocation database to update. Requests logged before about 21:00 UTC on 9 October 2026, when the sites switched to this log format, have no country and show as Unknown. Cities are recorded from about 13:30 UTC on 12 October 2026, only for requests the visitor function runs on (not /api calls, nor link.dliu.com, whose redirects are answered before it runs), and CloudFront has no city for some IPs. For an IP with no CloudFront city on a day, the city comes from DB-IP’s database if DB-IP agrees on the country, shown as “Nanjing (DB-IP)”; DB-IP is less precise, and some IPs still have none.'),
  t('标有 (DB-IP) 的城市由 DB-IP（https://db-ip.com）的 IP 地理定位数据提供，采用 CC BY 4.0 许可。', 'IP Geolocation by DB-IP (https://db-ip.com), licensed under CC BY 4.0, supplies the cities marked (DB-IP).'),
  t('访客按浏览器发送的 dl_vid cookie 统计。没有 cookie 的请求（例如首次访问）计入函数记录的 ID，前提是该 ID 在同一时段内以 cookie 形式回传过；否则按 IP 统计。满足以下任一条件的请求即视为机器人：User-Agent 缺失或标明是爬虫或脚本；或者机器人检查（每 6 小时一次）当天标记了它的 IP——来自云、托管或 VPN 网络，在扫描漏洞，在 AbuseIPDB 上被举报，或者从不加载页面的脚本、样式或 cookie。具体规则见“机器人识别”页面。CloudFront 本身不会标记机器人。除非勾选“包括机器人”，否则所有组件都会排除机器人；该选择会在 cookie 中保存一年。IP 和访客页面始终显示全部内容。', 'Visitors are counted by the dl_vid cookie the browser sent. A request without one, such as a first visit, counts under the ID the function logged, provided that ID came back as a cookie in the same period; otherwise it counts by IP. A request is a bot if its user agent is missing or names a crawler or script, or if the bot check (every 6 hours) flagged its IP for that day: a cloud, hosting or VPN network, scanning for weak spots, reported on AbuseIPDB, or never loading a page’s scripts, styles or cookie. The rules are on the Bot detection page. CloudFront does not flag bots itself. Bots are left out of every widget unless Include bots is ticked; that choice is remembered in a cookie for a year. The IP and Visitor pages always show everything.'),
  t('原始文件归档后立即删除（处理失败时 1 天后删除），整理后的日志 365 天后删除，Athena 结果 7 天后删除，CloudWatch 日志 90 天后删除。', 'Raw files are deleted once filed (after 1 day if filing fails), sorted logs after 365 days, Athena results after 7 days and CloudWatch logs after 90 days.'),
  t('网站列在 config/sites.json 中；在其中添加一个网站，就会为它添加分区，并在仪表板上添加它的卡片。', 'Sites are listed in config/sites.json; adding a site there adds its partition and its card on the dashboard.'),
]);
detailList(t('仪表板查询', 'Dashboard queries'), [
  t('每个组件各自运行查询，结果一到就显示，之前显示加载动画，因此慢的图表不会拖住总计数据。', 'Each widget runs its own query and appears as soon as its answer arrives, with a spinner until then, so a slow chart never holds up the totals.'),
  t('“所有网站”页面：七个查询，分别是总计、访问趋势、国家/地区、国家/地区筛选列表、各网站总计、各网站迷你趋势图和 IP 地址。', 'All sites page: seven queries for totals, visits over time, countries, the country filter list, per-site totals, per-site sparklines and IP addresses.'),
  t('网站页面：针对一个网站的八个查询，分别是总计、访问趋势、国家/地区、国家/地区筛选列表、热门页面、外部来源、IP 地址和请求日志。', 'Site page: eight queries for one site: totals, visits over time, countries, the country filter list, top pages, external referrers, IP addresses and its request log.'),
  t('国家/地区筛选：选择一个国家/地区（或在“国家/地区”表中点击一个国家/地区）后，“所有网站”、网站和页面三类页面上的每个组件都只显示该国家/地区的数据；该选择以 ?country= 保存在链接中。IP 和访客页面始终显示该 IP 或访客的全部活动。', 'Country filter: choosing a country (or clicking one in the Countries table) narrows every widget on the All sites, Site and Page pages to that country; it is kept in the link as ?country=. The IP and Visitor pages always show everything that IP or visitor did.'),
  t('页面详情页（在“热门页面”中点击一个页面）：针对某个网站上一个路径的九个查询，分别是总计、浏览趋势、访客从哪里来、阅读情况（摘要、时长和滚动分段，以及最新的浏览记录）、访客、IP 地址和请求。', 'Page page (click a page in Top pages): nine queries for one path on one site: totals, views over time, how visitors arrived, reading (summary, time and scroll buckets, and the latest page views), its visitors, its IP addresses and its requests.'),
  t('阅读情况：加载了页面脚本（traffic.dliu.com/t/s.js）的网站，会在页面停留 10 秒、30 秒、1、2、5 和 10 分钟时，以及页面隐藏或关闭时上报每次浏览（因此 5 秒的访问也会计入），附带截至当时的累计数据：屏幕停留秒数（从页面开始加载时算起）、最远滚动位置、屏幕尺寸、加载时间和脚本错误。一个 CloudFront Function 校验并记录每次上报；仪表板对每次浏览只保留最新一条。该脚本不设置任何 cookie。页面优先：网站在页面加载完成后才加载脚本，脚本会捕获自身的所有错误，从不等待上报完成，访客函数出错时也会原样返回响应，因此即使流量统计出故障，读者也不会察觉。', 'Reading: sites that load the page script (traffic.dliu.com/t/s.js) report each page view after 10 s, 30 s, 1, 2, 5 and 10 minutes on screen and when the page is hidden or closed (so a 5-second visit counts too), with the totals so far: seconds on screen (from when the page started loading), the furthest scroll, screen size, load time and script errors. A CloudFront Function checks and logs each report; the dashboard keeps the latest per view. The script sets no cookies. The page comes first: sites load the script after the page has loaded, the script catches all of its own errors and never waits for a report, and the visitor function returns the response unchanged if it fails, so a traffic outage goes unnoticed by readers.'),
  t('“访客从哪里来”：每位访客只计一次，以其首次浏览该页面为准。从微信分享的链接会带上 from=timeline（朋友圈）、from=singlemessage（聊天）或 from=groupmessage（群聊），每次转发都会再追加一个，因此最后一个说明该读者是从哪里看到的。没有该参数时，显示来源页的主机名；两者都没有的微信访问显示为“WeChat”，其余显示为“Direct”。', 'How visitors arrived: each visitor counts once, under their first view of the page. Links shared from WeChat get from=timeline (Moments), from=singlemessage (a chat) or from=groupmessage (a group), added again on each reshare, so the last one says where that reader found it. Without one it is the host of the referring page, “WeChat” for WeChat with neither, or “Direct”.'),
  t('IP 页面：针对该 IP 跨所有网站的五个查询，分别是摘要（含国家/地区、城市和网络）、访问过的网站、它的 dl_vid ID、使用相同 ID 的其他 IP，以及它的请求。', 'IP page: five queries across all sites for that IP: summary (with country, city and network), sites visited, its dl_vid IDs, other IPs with the same ID, and its requests.'),
  t('访客页面（点击一个 dl_vid 访客 ID）：针对该 ID 跨所有网站的六个查询，分别是摘要、访问过的网站、使用过的 IP 地址、浏览过的页面、阅读情况（页面脚本上报的每次浏览，含停留时长和滚动）以及它的请求。', 'Visitor page (click a dl_vid visitor ID): six queries across all sites for that ID: summary, sites visited, the IP addresses it used, the pages it viewed, its reading (each page view the page script reported, with time on screen and scroll) and its requests.'),
  t('表格在 Athena 中分页：只获取屏幕上显示的行（每次最多 100 行），并附带总数。搜索和“显示更多”会运行新查询，而不是筛选已下载的行。', 'Tables are paged in Athena: only the rows on screen are fetched (at most 100 per call), with a total count. Search and "Show more" run a new query instead of filtering rows already downloaded.'),
  t('时间范围：最近 24 小时、7、30 或 90 天，或最长 366 天的自定义时段，按本地时间以 YYYY-MM-DD HH:MM 格式输入。图表在 3 小时以内按分钟、3 天以内按小时、更长按天显示。', 'Ranges: last 24 hours, 7, 30 or 90 days, or a custom period of up to 366 days typed as YYYY-MM-DD HH:MM in your local time. Charts use minutes up to 3 hours, hours up to 3 days and days beyond that.'),
  t('所有查询都由固定模板生成；用户输入会先按允许列表和严格格式校验。', 'All queries are built from fixed templates; user input is validated against allowlists and strict patterns first.'),
]);
detailList(t('部署', 'Deployment'), [
  t('make deploy 先运行 Jest 测试，再运行 cdk deploy；静态文件随之上传，CloudFront 缓存也会被清除。', 'make deploy runs the Jest tests, then cdk deploy; static files are uploaded and the CloudFront cache is cleared.'),
  t('缓存：HTML 每次加载都重新验证；脚本和样式在 CloudFront 缓存一天，每次部署时清除。公开统计数据（stats/*.json）在 CloudFront 缓存一天、在浏览器中缓存 5 分钟；重写这些文件的函数随即清除缓存（每天一次 /stats/* 失效）。API、登录和日志文件从不缓存。', 'Caching: HTML is revalidated on every load; scripts and styles stay at CloudFront for a day and are cleared by each deploy. The public totals (stats/*.json) stay at CloudFront for a day and in browsers for 5 minutes; the function that rewrites them clears them right after (one /stats/* invalidation a day). The API, sign-in and log files are never cached.'),
  t('Microsoft Entra 设置在运行时从 SSM Parameter Store 读取，因此公开的代码仓库中不含任何 ID 或密钥。', 'Microsoft Entra settings are read from SSM Parameter Store at run time, so the public repository contains no IDs or secrets.'),
]);
root.append(more(t('更多技术细节（文字）', 'More technical details (text)'), details));

const footer = document.createElement('p');
footer.className = 'source';
footer.textContent = t('源代码：dliu-com/traffic-monitor', 'Source: dliu-com/traffic-monitor');
root.append(footer);
