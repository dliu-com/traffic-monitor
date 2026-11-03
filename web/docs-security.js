import { tiers, stats, table, callout, more } from './diagram.js';
import { t } from './i18n.js';

const root = document.getElementById('security');
const add = (tag, text) => {
  const node = document.createElement(tag);
  node.textContent = text;
  root.append(node);
  return node;
};
const PASS = { text: t('✓ 通过', '✓ Pass'), className: 'status' };
const FIXED = { text: t('✓ 已修复', '✓ Fixed'), className: 'status fixed' };
const LOW = { text: t('低', 'Low'), className: 'risk-low' };
const MEDIUM = { text: t('中', 'Medium'), className: 'risk-medium' };

root.append(callout('shield', t('已于 2026 年 10 月 9 日针对线上网站完成审查和测试。发现的四个问题均已于当天修复，没有任何数据泄露。', 'Reviewed and tested against the live site on 9 October 2026. Four issues were found and fixed the same day; none exposed data.')));

root.append(tiers({
  title: t('信任边界', 'Trust boundaries'),
  rows: [
    {
      label: t('任何人', 'Anyone'), badge: t('不可信', 'Untrusted'), tone: 'untrusted',
      nodes: [
        { icon: 'browser', title: t('网站访客', 'Site visitors'), text: t('可以控制自己的 User-Agent、Referrer、路径、查询字符串和 Cookie，这些最终都会写入日志', 'Control their user agent, referrer, path, query and cookies, all of which end up in the logs') },
        { icon: 'bot', title: t('攻击者', 'Attackers'), text: t('可以直接调用 traffic.dliu.com 及其 /api 和 /auth 路径，以及任何 AWS 端点', 'Can call traffic.dliu.com, its /api and /auth paths, and any AWS endpoint directly') },
      ],
    },
    {
      label: 'CloudFront', badge: t('边缘', 'Edge'), tone: 'edge', link: t('仅限 HTTPS，仅限 GET 和 HEAD', 'HTTPS only, GET and HEAD only'),
      nodes: [
        { icon: 'cloudfront', title: t('仪表板分配', 'Dashboard distribution'), text: t('TLS 1.2+、安全响应头、来自私有存储桶的静态页面', 'TLS 1.2+, security headers, static pages from a private bucket') },
        { icon: 'cookie', title: t('访客 ID 函数', 'Visitor ID function'), text: t('替换任何不是普通随机 ID 的 dl_vid', 'Replaces any dl_vid that is not a plain random ID') },
      ],
    },
    {
      label: t('仪表板 Lambda', 'Dashboard Lambda'), badge: 'API', tone: 'app', link: t('由 CloudFront 签名（IAM）', 'signed by CloudFront (IAM)'),
      nodes: [
        { icon: 'lock', title: t('会话检查', 'Session check'), text: t('每个 /api 调用都需要有效的已签名会话 Cookie', 'Every /api call needs a valid signed session cookie') },
        { icon: 'filter', title: t('输入允许列表', 'Input allowlists'), text: t('网站、时段、日期、时间、国家、访客 ID、IP 和搜索文本都会在构建任何 SQL 之前经过校验', 'Sites, ranges, dates, times, countries, visitor IDs, IPs and search text are validated before any SQL is built') },
      ],
    },
    {
      label: t('AWS 账号', 'AWS account'), badge: t('私有', 'Private'), tone: 'private', link: t('最小权限角色', 'least-privilege role'),
      nodes: [
        { icon: 's3', title: t('日志存储桶', 'Log buckets'), text: t('禁止公开访问、加密、仅限 HTTPS；只有本账号的 CloudFront 日志传输可以写入 raw-v2/', 'No public access, encrypted, HTTPS only; only this account’s CloudFront log delivery may write raw-v2/') },
        { icon: 'athena', title: 'Athena', text: t('只读查询，扫描上限 1 GB', 'Read-only queries, 1 GB scan cap') },
        { icon: 'ssm', title: 'Parameter Store', text: t('客户端密钥加密存储，绝不写在代码里', 'Client secret stored encrypted, never in code') },
      ],
    },
  ],
  note: t('Lambda 之上的一切都视为恶意。日志字段是攻击者可控的数据，因此只会作为文本显示，绝不放入 SQL。', 'Everything above the Lambda is treated as hostile. Log fields are attacker-controlled data, so they are only ever displayed as text and never placed into SQL.'),
}));

add('h2', t('公开限制', 'Public limits'));
root.append(stats([
  ['1 GB', t('每次查询最多扫描的数据量', 'maximum data scanned per query'), 'budget'],
  [t('366 天', '366 days'), t('自定义日期范围的最长跨度', 'longest custom date range'), 'clock'],
  [t('100 行', '100 rows'), t('每次调用最多返回的行数', 'most rows returned per call'), 'filter'],
  [t('12 小时', '12 hours'), t('会话有效期', 'session lifetime'), 'lock'],
]));

add('h2', t('线上渗透测试', 'Live penetration test'));
add('p', t('每项测试都使用 curl、openssl 和一个小型 Node 脚本针对 https://traffic.dliu.com 运行。需要登录的测试使用了真实会话。', 'Each test was run against https://traffic.dliu.com with curl, openssl and a small Node script. The signed-in tests used a real session.'));
root.append(table([t('测试', 'Test'), t('结果', 'Result'), t('状态', 'Status')], [
  [t('HTTP 降级', 'HTTP downgrade'), t('http:// 返回 301 跳转到 https://；HSTS 有效期为一年', 'http:// answers 301 to https://; HSTS is set for one year'), PASS],
  [t('旧版 TLS', 'Old TLS versions'), t('拒绝 TLS 1.0 和 1.1；TLS 1.2 和 1.3 正常', 'TLS 1.0 and 1.1 are refused; TLS 1.2 and 1.3 work'), PASS],
  [t('安全响应头', 'Security headers'), t('CSP 只允许来自本站的脚本（无内联脚本）；禁止被嵌入框架；nosniff；不发送 Referrer', "CSP allows scripts only from the site itself (no inline scripts); framing is denied; nosniff; no referrer sent"), PASS],
  [t('浏览器功能与窗口隔离响应头', 'Browser feature and window isolation headers'), t('原先缺少 Permissions-Policy 和 Cross-Origin-Opener-Policy，现已发送这两个响应头', 'Permissions-Policy and Cross-Origin-Opener-Policy were missing; both are now sent'), FIXED],
  [t('隐藏文件', 'Hidden files'), t('/.git/config、/.env、source map、package.json、cdk.json 和网站列表均返回 403；不提供目录列表', '/.git/config, /.env, source maps, package.json, cdk.json and the site list all return 403; no directory listing'), PASS],
  [t('其他 HTTP 方法', 'Other HTTP methods'), t('POST、PUT、DELETE、PATCH 和 OPTIONS 返回 403；TRACE 返回 405；CONNECT 返回 400', 'POST, PUT, DELETE, PATCH and OPTIONS return 403; TRACE 405; CONNECT 400'), PASS],
  [t('路径花招', 'Path tricks'), t('编码后的 ../、空字节、大写和双斜杠都无法到达 API（返回 400、403 或 404）', 'Encoded ../, null bytes, upper case and double slashes never reach the API (400, 403 or 404)'), PASS],
  [t('伪造会话', 'Forged sessions'), t('无 Cookie、未签名、alg:none、替换载荷、已过期、错误密钥、截断签名和伪造用户头均返回 401', 'No cookie, unsigned, alg:none, swapped payload, expired, wrong key, truncated signature and fake user headers all return 401'), PASS],
  [t('登录 Cookie 被当作会话重放', 'Sign-in cookie replayed as a session'), t('/auth/login 发给任何人的 __Host-tm_auth Cookie 与会话 Cookie 签名方式相同，因此把它作为 __Host-tm_session 发送就能打开仪表板。现在登录 Cookie 和会话 Cookie 使用不同的密钥，并校验类型；所有旧会话均已失效', 'The __Host-tm_auth cookie that /auth/login gives anyone was signed like a session, so sending it as __Host-tm_session opened the dashboard. Sign-in and session cookies now use different keys and a checked type; all older sessions were ended'), FIXED],
  [t('访问日志中的会话 Cookie', 'Session cookies in the access logs'), t('各网站为获取访客 ID 会记录 Cookie 头，因此日志里也保存了这些网站的登录会话 Cookie，最长达一年。分区器现在只保留 dl_vid，所有已归档的日志也按同样方式重写', 'The sites log the Cookie header for the visitor ID, so the logs also held the sites’ sign-in session cookies for up to a year. The partitioner now keeps only dl_vid, and every filed log was rewritten the same way'), FIXED],
  [t('登录回调', 'Sign-in callback'), t('缺失或伪造的 state 返回 400；返回地址固定，因此不存在开放重定向', 'Missing or forged state returns 400; the return address is fixed, so there is no open redirect'), PASS],
  [t('登录错误文本', 'Sign-in error text'), t('?error= 中的任意文本曾显示在页面上（已转义，无法执行）。现在只显示已知的错误代码', 'Arbitrary text in ?error= was shown on the page (escaped, so not executable). Only known error codes are shown now'), FIXED],
  [t('响应头注入', 'Header injection'), t('回调参数中的换行符无法添加响应头或 Cookie', 'Line breaks in callback parameters cannot add headers or cookies'), PASS],
  [t('跨域请求', 'Cross-origin requests'), t('不发送 CORS 响应头，因此其他网站无法读取 API；预检请求返回 403', 'No CORS headers are sent, so other sites cannot read the API; preflight returns 403'), PASS],
  [t('绕过 CloudFront', 'Bypassing CloudFront'), t('直接调用 Lambda 函数 URL 和全部三个 S3 存储桶均返回 403', 'The Lambda function URL and all three S3 buckets return 403 when called directly'), PASS],
  [t('SQL 注入', 'SQL injection'), t('site、range、from、to、country、visitor、ip、list 和 part 中的引号、注释和 UNION 载荷均返回 400。含引号、分号或尖括号的搜索文本返回 400；其他词语只会作为纯文本匹配', "Quotes, comments and UNION payloads in site, range, from, to, country, visitor, ip, list and part return 400. Search text with quotes, semicolons or angle brackets returns 400; other words are only ever matched as plain text"), PASS],
  [t('原型键', 'Prototype keys'), t('range=__proto__ 或 toString 曾导致 500 错误，现在返回 400', 'range=__proto__ or toString caused a 500 error; they now return 400'), FIXED],
  [t('超大请求', 'Oversized requests'), t('超过 366 天的时段和重复参数返回 400；limit 被限制在 1–100', 'Ranges over 366 days and repeated parameters return 400; limit is clamped to 1–100'), PASS],
  [t('存储型 XSS', 'Stored XSS'), t('把 script 和 onerror 载荷放在 User-Agent、Referrer、路径、查询字符串和 Cookie 中发送到 dliu.com，再在仪表板中查看。它们都显示为纯文本，没有任何代码执行', 'Script and onerror payloads were sent to dliu.com in the user agent, referrer, path, query and cookie, then viewed in the dashboard. They appear as plain text and nothing runs'), PASS],
  [t('恶意访客 Cookie', 'Malicious visitor cookie'), t('包含 <script> 的 dl_vid 会被替换为新的随机 ID', 'A dl_vid containing <script> is replaced with a fresh random ID'), PASS],
  [t('错误页面样式', 'Error page styling'), t('错误页面曾使用被 CSP 拦截的内联样式，现在改用样式表', 'The error page used an inline style that the CSP blocked; it now uses the stylesheet'), FIXED],
  [t('公开仓库中的机密', 'Secrets in the public repo'), t('扫描了完整的 git 历史：没有机密、密钥、账号 ID、租户 ID 或客户端 ID', 'Full git history scanned: no secrets, keys, account, tenant or client IDs'), PASS],
  [t('依赖项', 'Dependencies'), t('生产环境不运行任何第三方包；34 条安全公告只影响本地测试工具', 'No third-party packages run in production; 34 advisories affect only the local test tools'), PASS],
]));

add('h2', t('威胁模型', 'Threat model'));
root.append(table([t('场景', 'Scenario'), t('剩余风险', 'Residual risk'), t('控制措施', 'Controls')], [
  [t('访客在 User-Agent、Referrer 或 URL 中放入脚本，使其在管理员查看日志时运行（存储型 XSS）', 'A visitor puts a script in their user agent, referrer or URL so it runs when the admin views the logs (stored XSS)'), LOW, t('所有值都用 textContent 渲染，从不使用 innerHTML；CSP 拦截内联脚本和第三方脚本；已用真实载荷测试', 'Every value is rendered with textContent, never innerHTML; CSP blocks inline and third-party scripts; tested with live payloads')],
  [t('精心构造的登录链接显示误导性文本或脚本（反射型 XSS）', 'A crafted sign-in link shows misleading text or script (reflected XSS)'), LOW, t('输出经过 HTML 转义；只显示已知的 OAuth 错误代码', 'Output is HTML-escaped; only known OAuth error codes are displayed')],
  [t('利用筛选条件向 Athena 注入 SQL', 'Filters are used to inject SQL into Athena'), LOW, t('网站、时段、列表和部分都来自固定列表；日期、时间、国家（两个大写字母）、访客 ID 和 IP 必须匹配严格的格式；搜索文本仅限字母、数字和少数安全符号；不接受用户编写的 SQL；角色只能读取', 'Sites, ranges, lists and parts come from fixed lists; dates, times, countries (two capital letters), visitor IDs and IPs must match strict patterns; search text is limited to letters, digits and a few safe symbols; no user-written SQL; the role can only read')],
  [t('攻击者伪造或窃取会话 Cookie', 'An attacker forges or steals a session cookie'), LOW, t('HMAC-SHA256 签名、12 小时过期、HttpOnly、Secure、SameSite=Lax，__Host- 前缀使同级子域名无法设置它；登录 Cookie 使用不同的密钥和类型，因此无法被当作会话重放', 'HMAC-SHA256 signature, 12-hour expiry, HttpOnly, Secure, SameSite=Lax, __Host- prefix so sibling subdomains cannot set it; the sign-in cookie uses a different key and type, so it cannot be replayed as a session')],
  [t('从访问日志中读取被监控网站的会话 Cookie', 'Session cookies of the monitored sites are read from the access logs'), LOW, t('CloudFront 会记录完整的 Cookie 头，但分区器在归档日志之前只保留 dl_vid=<id>；未处理的文件只存在到归档为止（几秒钟），且存储桶是私有的', 'CloudFront logs the whole Cookie header, but the partitioner keeps only dl_vid=<id> before filing a log; the unprocessed file lives only until it is filed (seconds), and the bucket is private')],
  [t('登录 CSRF、授权码拦截或开放重定向', 'Login CSRF, code interception or an open redirect'), LOW, t('state、nonce 和 PKCE（S256）；固定的重定向 URI；校验 ID 令牌的签名、颁发者、租户、受众和过期时间', 'state, nonce and PKCE (S256); fixed redirect URI; ID token signature, issuer, tenant, audience and expiry checked')],
  [t('使用其他 Microsoft 账号的人登录', 'Someone with another Microsoft account signs in'), LOW, t('单租户应用，要求分配用户，Lambda 中还会检查 @dliu.com 域名', 'Single-tenant app with assignment required, plus an @dliu.com domain check in the Lambda')],
  [t('绕过 CloudFront 直接调用 Lambda 或存储桶', 'The Lambda or buckets are called without CloudFront'), LOW, t('函数 URL 要求来自 CloudFront 的 IAM 认证（OAC）；存储桶禁止公开访问，只允许 CloudFront 访问', 'Function URL requires IAM auth from CloudFront (OAC); buckets block public access and allow only CloudFront')],
  [t('仪表板被嵌入框架进行点击劫持', 'The dashboard is framed for clickjacking'), LOW, t("frame-ancestors 'none'、X-Frame-Options DENY 和 Cross-Origin-Opener-Policy", "frame-ancestors 'none', X-Frame-Options DENY and Cross-Origin-Opener-Policy")],
  [t('公开的托管网络列表被篡改，以隐藏真实访客或注入代码', 'A public hosting-network list is tampered with to hide real visitors or inject code'), LOW, t('只有 ASN（范围内的整数）会进入 SQL；名称被精简为纯文本并用 textContent 显示；下载内容过小或下载失败时保留上一份；Cloudflare 和 iCloud Private Relay 始终排除；它只影响机器人筛选', 'Only ASNs (whole numbers in range) reach SQL; names are reduced to plain text and shown with textContent; too-small or failed downloads keep the last copy; Cloudflare and iCloud Private Relay are always excluded; it only affects the bot filter')],
  [t('伪造的 dl_vid Cookie 或脚本请求扭曲统计数字', 'Fake dl_vid cookies or scripted requests distort the numbers'), MEDIUM, t('校验 Cookie 格式和客户端提示（client hints），并默认隐藏机器人；这些数据仅用于分析，不授予任何访问权限', 'Cookie format and client hints are validated and bots are hidden by default; the data is analytics only and grants no access')],
  [t('大量请求推高账单', 'Request floods run up the bill'), LOW, t('查询需要登录；每次查询扫描达到 1 GB 即停止；重复查询在 5 分钟内复用结果；未认证的调用以很低的成本返回 401', 'Queries need sign-in; each query stops at 1 GB scanned; repeat queries reuse results for 5 minutes; unauthenticated calls return 401 cheaply')],
  [t('机密通过公开仓库泄露', 'Secrets leak through the public repository'), LOW, t('客户端密钥、租户 ID 和客户端 ID 存放在加密的 SSM 参数中，运行时读取；已扫描 git 历史', 'The client secret, tenant and client IDs live in encrypted SSM parameters read at run time; git history scanned')],
  [t('有人向日志存储桶写入伪造的日志文件，以植入虚假访问', 'Someone writes forged log files into the log bucket to plant fake visits'), LOW, t('存储桶策略只允许日志传输服务写入，只能写入 raw-v2/，且只限本账号中的传输源（aws:SourceAccount 和 aws:SourceArn）；分区器只接受 raw-v2/<site>/YYYY/MM/DD/ 下的文件，并按列名重写其中的列', 'The bucket policy lets only the log delivery service write, only to raw-v2/, only for delivery sources in this account (aws:SourceAccount and aws:SourceArn); the partitioner only accepts files under raw-v2/<site>/YYYY/MM/DD/ and rewrites their columns by name')],
  [t('利用记录下的访客 ID、国家或城市攻击仪表板', 'The logged visitor ID, country or city is used to attack the dashboard'), LOW, t('ID 由我们自己的函数在校验格式后写入；查询只接受由 8 到 40 个小写字母和数字组成的 ID，只接受纯数字的 ASN；城市以十六进制记录，只有解码后仅含字母、数字、空格和 . \' ’ ( ) , -（最多 60 个字符）时才保留；DB-IP 城市在保存前和查询时都要通过同样的检查；国家和城市都用 textContent 显示', 'The ID is written by our own function after it checks the format; queries accept it only if it is 8 to 40 lowercase letters and digits, the ASN only if it is digits; the city is logged as hex and kept only if it decodes to letters, digits, spaces and . \' ’ ( ) , - (at most 60); DB-IP cities pass the same check before they are saved and again in queries; countries and cities are shown with textContent')],
  [t('被篡改的 DB-IP 城市数据库让仪表板显示错误的城市', 'A tampered DB-IP city database puts wrong cities on the dashboard'), LOW, t('每月通过 HTTPS 下载一次，并在替换上一份之前进行检查（MaxMind DB 格式、City 数据库、Google DNS 定位在美国）；只有当城市所属国家与 CloudFront 给出的一致时才保留；它只影响“城市”列', 'It is downloaded over HTTPS once a month and checked (MaxMind DB format, a City database, Google DNS placed in the US) before it replaces the last copy; a city is kept only when its country matches CloudFront\'s; it only changes the City column')],
  [t('其他网站诱使已登录的管理员启动机器人检查（CSRF）', 'Another site makes the signed-in admin start bot checks (CSRF)'), LOW, t('“立即检查机器人”是唯一的 POST 端点；它需要会话 Cookie（SameSite=Lax，因此跨站 POST 不会携带）以及值为 https://traffic.dliu.com 的 Origin 头，且同一时间只运行一次检查', 'Check bots now is the only POST endpoint; it needs the session cookie (SameSite=Lax, so not sent on cross-site POSTs) and an Origin header of https://traffic.dliu.com, and only one check runs at a time')],
  [t('AbuseIPDB 密钥泄露或其响应被篡改', 'The AbuseIPDB key leaks or its answers are tampered with'), LOW, t('密钥是加密的 SSM 参数，只有机器人检查 Lambda 能读取；响应在保存前被精简为整数、true/false 和纯文本名称，并用 textContent 显示', 'The key is an encrypted SSM parameter read only by the bot check Lambda; answers are reduced to whole numbers, true/false and plain-text names before they are saved, and shown with textContent')],
  [t('访客 IP 被分享给第三方', 'Visitor IPs are shared with a third party'), MEDIUM, t('只把 IP 地址通过 HTTPS 发送给 AbuseIPDB，每个 IP 每 30 天最多一次，且只针对看起来像真人的 IP', 'Only the IP address is sent to AbuseIPDB, over HTTPS, at most once per IP every 30 days, and only for IPs that look like people')],
  [t('伪造的页面脚本上报扭曲阅读时长，或被用来攻击仪表板', 'Forged page script reports distort reading time or are used to attack the dashboard'), LOW, t('上报在记录之前先在边缘校验：网站必须在列表中，且与 Origin 或 Referer 匹配（两者都没有的上报会被丢弃；浏览器之外的工具仍可伪造），每个数字都做范围检查，浏览 ID 必须是 6 到 16 个小写字母和数字，路径以十六进制记录，解码后必须是最多 200 个可打印字符；其他情况一律返回 204 并丢弃。仪表板自身的日志不记录 Cookie 和查询字符串（登录授权码）。阅读数据仅用于分析，同样排除机器人，所有值都用 textContent 显示', 'Reports are checked at the edge before they are logged: the site must be listed and match the Origin or Referer (a report with neither is dropped; tools outside a browser can still fake them), every number is range-checked, the view ID is 6 to 16 lowercase letters and digits, the path is logged as hex and must decode to at most 200 printable characters; anything else is answered 204 and dropped. The logs of the dashboard itself leave out cookies and query strings (sign-in codes). Reading data is analytics only, bots are left out the same way, and values are shown with textContent')],
  [t('访客伪造页面加载或 Cookie 以免被标记', 'A visitor fakes page loads or a cookie to avoid being flagged'), MEDIUM, t('机器人标记只影响分析数据；托管网络、扫描器和 AbuseIPDB 规则依然适用', 'Bot flags only affect the analytics; the hosting, scanner and AbuseIPDB rules still apply')],
  [t('每日日志合并出错，删除了真人的请求', 'A fault in the daily log merge deletes people\'s requests'), LOW, t('合并角色只能删除 logs/ 下的文件，只能写入 archive/；它先写入合并后的文件，再删除被替换的文件，并按 CloudFront 请求 ID 去重，因此重复运行是安全的；它只合并已完成的机器人检查判定过的日期；已在模拟存储桶上测试', 'The merge role may delete only under logs/ and write only under archive/; it writes the merged file before deleting the files it replaces, de-duplicates by CloudFront request ID so reruns are safe, and only merges days the finished bot check has judged; tested against a fake bucket')],
  [t('未登录用户的访问推高 Athena 账单', 'Guest visits run up the Athena bill'), LOW, t('未登录用户读取预先计算好的总数（stats/*.json），每天刷新一次；他们从不发起查询', 'Guests read pre-computed totals (stats/*.json), refreshed once a day; they never start a query')],
  [t('记录的 IP 地址和访客 ID 被泄露', 'Logged IP addresses and visitor IDs are exposed'), MEDIUM, t('只有管理员能查询它们；存储桶是私有且加密的；原始日志 7 天后删除，整理后的日志 1 年后删除', 'Only the admin can query them; buckets are private and encrypted; raw logs deleted after 7 days, sorted logs after 1 year')],
]));

add('h2', t('已接受的剩余风险', 'Accepted residual risks'));
const risks = document.createElement('ul');
for (const text of [
  t('没有 WAF 或速率限制。未认证的 /api 或 /auth 调用仍会启动 Lambda，由它以极低的成本返回 401。', 'There is no WAF or rate limit. Unauthenticated calls to /api or /auth still start the Lambda, which answers 401 for a tiny cost.'),
  t('访客 ID 并非密码学意义上的随机值，任何人都可以设置自己的 dl_vid。它们用于统计访客，而非用于安全。', 'Visitor IDs are not cryptographically random and anyone can set their own dl_vid. They are for counting visitors, not for security.'),
  t('日志中包含 IP 地址、访客 ID 以及每个 IP 的国家、城市和网络（属于个人数据），最长保存一年。', 'Logs contain IP addresses, visitor IDs and the country, city and network of each IP (personal data) for up to one year.'),
  t('会话无法在服务器端撤销；被盗的 Cookie 在过期前一直有效（最长 12 小时）。', 'Sessions cannot be revoked on the server; a stolen cookie works until it expires (at most 12 hours).'),
  t('退出登录是一个普通链接，因此其他网站可以让管理员退出登录。除此之外，无法以这种方式触发任何操作。', 'Sign-out is a plain link, so another site could sign the admin out. Nothing else can be triggered that way.'),
  t('为了检查机器人，访客 IP 地址会发送给第三方 AbuseIPDB。DB-IP 城市查询在本地完成，因此不会向 DB-IP 发送任何 IP。', 'Visitor IP addresses are sent to AbuseIPDB, a third party, for the bot check. The DB-IP city lookups are local, so no IP is sent to DB-IP.'),
  t('未知页面返回 403 而不是 404，因为存储桶不允许列出内容。', 'Unknown pages return 403 rather than 404, because the bucket does not allow listing.'),
  t('HSTS 不覆盖子域名，也未加入预加载列表，因为 dliu.com 的其他子域名是单独管理的。', 'HSTS does not cover subdomains and is not preloaded, because other dliu.com subdomains are managed separately.'),
  t('域名检查依赖账号名，而账号名只有目录管理员才能更改。', 'The domain check relies on the account name, which only directory administrators can change.'),
  t('本地测试工具有 34 条已知安全公告；它们从不在生产环境中运行。', 'The local test tools have 34 known advisories; they never run in production.'),
  t('没有 security.txt 文件。', 'There is no security.txt file.'),
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
detailList(t('响应头', 'Response headers'), [
  "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' https://files.dliu.com/dliu.com/ui/; img-src 'self' data: https://files.dliu.com/dliu.com/; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Strict-Transport-Security: max-age=31536000',
  'X-Frame-Options: DENY · X-Content-Type-Options: nosniff · Referrer-Policy: no-referrer',
  t('Permissions-Policy：禁用 camera、microphone、geolocation、payment、usb 和 interest-cohort', 'Permissions-Policy: camera, microphone, geolocation, payment, usb and interest-cohort disabled'),
  'Cross-Origin-Opener-Policy: same-origin · X-Robots-Tag: noindex, nofollow',
  t('API 响应还会发送 Cache-Control: no-store', 'API responses also send Cache-Control: no-store'),
]);
detailList(t('登录与会话', 'Sign-in and session'), [
  t('使用 PKCE（S256）、state 和 nonce 的授权码流程，这些值在 __Host-tm_auth Cookie 中保存 10 分钟', 'Authorization code flow with PKCE (S256), state and nonce, held for 10 minutes in a __Host-tm_auth cookie'),
  t('使用 Node crypto 按 Microsoft 公布的密钥验证 ID 令牌：RS256 签名、颁发者、租户、受众、nonce，以及允许 2 分钟时钟偏差的过期时间', 'ID token verified with Node crypto against Microsoft’s published keys: RS256 signature, issuer, tenant, audience, nonce, and expiry with 2 minutes of clock skew'),
  t('会话 Cookie __Host-tm_session：使用从客户端密钥派生的密钥进行 HMAC-SHA256 签名，有效期 12 小时，HttpOnly、Secure、SameSite=Lax，仅限当前主机', 'Session cookie __Host-tm_session: HMAC-SHA256 with a key derived from the client secret, 12 hours, HttpOnly, Secure, SameSite=Lax, host-only'),
  t('登录 Cookie 使用单独的密钥签名，并标记为 typ: login；会话必须是 typ: session 并指明用户', 'The sign-in cookie is signed with a separate key and marked typ: login; a session must be typ: session and name a user'),
]);
detailList('AWS', [
  t('Lambda 角色只能在自己的 Athena 工作组中运行查询、读取自己的 Glue 表、读取 /traffic-monitor/ 下的参数，并使用自己的存储桶前缀', 'The Lambda role can only run queries in its own Athena workgroup, read its Glue tables, read parameters under /traffic-monitor/ and use its own bucket prefixes'),
  t('所有存储桶都禁止公开访问、使用 S3 托管加密，并拒绝明文 HTTP', 'All buckets block public access, use S3-managed encryption and reject plain HTTP'),
  t('Athena 工作组设置为强制执行，因此查询无法自行提高扫描上限', 'Athena workgroup settings are enforced, so a query cannot raise its own scan limit'),
  t('CloudFront 日志传输（us-east-1）通过 delivery.logs.amazonaws.com 写入日志存储桶，存储桶策略将其限制为 raw-v2/*、bucket-owner-full-control、本账号及其自身的传输源', 'CloudFront log deliveries (us-east-1) write to the log bucket through delivery.logs.amazonaws.com, limited by the bucket policy to raw-v2/*, bucket-owner-full-control, this account and its own delivery sources'),
  t('分区器只能读取和删除原始文件、写入 logs/；每个 raw-v2 文件归档后即被删除', 'The partitioner can only read and delete raw files and write logs/; it deletes each raw-v2 file once it has been filed'),
  t('机器人检查 Lambda 可以读取 logs/ 和 hosting/，读写 bots/、reputation/、bot-state/ 和 abuseipdb/runs/，读取 AbuseIPDB 密钥，并在 traffic 工作组中运行查询', 'The bot check Lambda can read logs/ and hosting/, read and write bots/, reputation/, bot-state/ and abuseipdb/runs/, read the AbuseIPDB key and run queries in the traffic workgroup'),
  t('仪表板 Lambda 可以读取 logs/、archive/、bots/、reputation/ 和 abuseipdb/，只能写入 bots/status.json，并可启动机器人检查 Lambda', 'The dashboard Lambda can read logs/, archive/, bots/, reputation/ and abuseipdb/, write only bots/status.json and start the bot check Lambda'),
  t('日志合并 Lambda 可以读取 logs/、bots/ 和 archive/，只能写入 archive/，只能删除 logs/ 下的文件；它不能运行查询', 'The log merge Lambda can read logs/, bots/ and archive/, write only archive/ and delete only logs/; it cannot run queries'),
]);
details.append(document.createElement('h3'));
details.lastChild.textContent = t('延伸阅读', 'Further reading');
const links = document.createElement('ul');
for (const [href, text] of [
  ['https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html', t('OWASP XSS 防护速查表', 'OWASP XSS prevention cheat sheet')],
  ['https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html', t('OWASP 输入校验速查表', 'OWASP input validation cheat sheet')],
  ['https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html', t('OWASP REST 安全速查表', 'OWASP REST security cheat sheet')],
  ['https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html', t('OWASP 会话管理速查表', 'OWASP session management cheat sheet')],
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
root.append(more(t('更多技术细节（文字）', 'More technical details (text)'), details));

const footer = document.createElement('p');
footer.className = 'source';
footer.textContent = t('源代码：dliu-com/traffic-monitor · 另见“技术架构”和“成本”选项卡。', 'Source: dliu-com/traffic-monitor · See also the Architecture and Running costs tabs.');
root.append(footer);
