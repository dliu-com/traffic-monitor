import { flow, tiers, stats, table, more, callout } from './diagram.js';
import { t } from './i18n.js';

const root = document.getElementById('bot-detection');

function add(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  root.append(node);
  return node;
}

function list(items) {
  const ul = document.createElement('ul');
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    ul.append(li);
  }
  root.append(ul);
}

root.append(stats([
  [t('6 小时', '6 hours'), t('今天及前 3 天的检查间隔', 'between checks of today and the 3 days before'), 'clock'],
  [t('5 条规则', '5 rules'), t('按固定顺序逐条检查', 'tried in a fixed order'), 'filter'],
  ['1,000', t('每天的 AbuseIPDB 查询次数，所有运行共用', 'AbuseIPDB lookups a day, shared by all runs'), 'shield'],
  ['0', t('仅凭名称判定的浏览器', 'browsers judged by their name'), 'browser'],
]));

add('h2', t('规则', 'The rules'));
add('p', t('只要 User-Agent 露出马脚，请求就会被判为机器人。其余规则每 6 小时按 IP 地址和日期（UTC）判定一次，覆盖所有网站，第一条匹配的规则就是仪表板上显示的原因。', 'A request is a bot if its user agent gives it away. Every other rule is judged every 6 hours for each IP address and day (UTC), across all sites together, and the first rule that matches is the reason shown on the dashboard.'));
root.append(flow({
  title: t('检查顺序', 'Checks, in order'),
  numbered: true,
  steps: [
    { icon: 'bot', title: t('爬虫或脚本', 'Crawler or script'), text: t('User-Agent 缺失，或标明自己是爬虫、HTTP 库或工具（bot、spider、curl、python、Go…）。每个请求都会立即检查', 'The user agent is missing or names a crawler, HTTP library or tool (bot, spider, curl, python, Go…). Checked on every request, straight away') },
    { icon: 'cloudfront', title: t('托管网络', 'Hosting network'), text: t('IP 属于云、托管或 VPN 网络（约 950 个 ASN）', 'The IP belongs to a cloud, hosting or VPN network (about 950 ASNs)') },
    { icon: 'eye', title: t('扫描器', 'Scanner'), text: t('请求了只有攻击者才会找的路径：/.env、/.git、wp-login、phpMyAdmin、.php 文件、备份文件…', 'It asked for paths only attackers look for: /.env, /.git, wp-login, phpMyAdmin, .php files, backups…') },
    { icon: 'shield', title: t('被举报滥用', 'Reported abuse'), text: t('AbuseIPDB 给出 50% 或以上的滥用置信度，或将其列为 Tor 出口节点或数据中心', 'AbuseIPDB gives it 50% or more abuse confidence, lists it as a Tor exit, or as a data centre') },
    { icon: 'code', title: t('从不加载页面', 'Never loads a page'), text: t('一整天都没有获取任何脚本、样式表或字体，也从未回传 dl_vid Cookie', 'All day it fetched no script, stylesheet or font and never sent back the dl_vid cookie') },
    { icon: 'users', title: t('真人', 'Person'), text: t('以上都不匹配', 'Nothing matched'), tone: 'private' },
  ],
  note: t('图片不算加载页面：聊天应用生成链接预览时只获取页面本身及其预览图。', 'Pictures do not count as loading a page: link previews in chat apps fetch only the page and its preview image.'),
}));

root.append(table([t('原因', 'Reason'), t('显示为', 'Shown as'), t('为何有效', 'Why it works')], [
  ['agent', t('爬虫或脚本（User-Agent）', 'crawler or script (user agent)'), t('守规矩的爬虫和工具会表明身份，而浏览器总会发送 User-Agent', 'Honest crawlers and tools say what they are. A browser always sends a user agent')],
  ['hosting', t('云或托管网络', 'cloud or hosting network'), t('人们在家庭、移动和办公网络上浏览网页，而不是从服务器上。Cloudflare WARP、iCloud Private Relay、Fastly 和 Apple 承载的是真人流量，因此从不计入', 'People browse from home, mobile and office networks, not from servers. Cloudflare WARP, iCloud Private Relay, Fastly and Apple are never counted, as they carry real people')],
  ['probe', t('扫描漏洞', 'scanned for weak spots'), t('dliu.com 的网站都没有使用 PHP、WordPress 或点文件，所以没有人有理由请求它们', 'None of the dliu.com sites use PHP, WordPress or dotfiles, so nobody has a reason to ask for them')],
  ['abuse', t('在 AbuseIPDB 上被举报', 'reported on AbuseIPDB'), t('其他网站所有者会举报攻击过他们的 IP；AbuseIPDB 也知道哪些 IP 属于数据中心和 Tor 出口节点', 'Other site owners report IPs that attacked them; AbuseIPDB also knows which IPs are data centres and Tor exits')],
  ['headless', t('从未加载脚本、样式或 Cookie', 'never loaded scripts, styles or the cookie'), t('真正显示页面的浏览器也会加载页面的脚本和样式，或者带着 Cookie 再次访问。伪装成浏览器 User-Agent 的脚本通常只获取 HTML', 'A browser that shows a page also loads its scripts and styles, or comes back with the cookie. Scripts that fake a browser user agent usually fetch only the HTML')],
]));

add('p', t('status.dliu.com 每 15 分钟以游客身份检查每个网站，User-Agent 为 dliu-status-bot/1.0。这些请求在写入日志分区之前就被丢弃，因此不会出现在机器人页面，也不会被 Athena 扫描、参与机器人检查或查询 AbuseIPDB。它还每小时通过 Globalping（jsDelivr 的免费探针网络）从中国大陆检查一次，这些探针的 User-Agent 固定以 globalping probe 开头，也同样被丢弃（别人用 Globalping 做的测试同样是合成流量，也一并丢弃）。', 'status.dliu.com checks every site as a guest every 15 minutes, with the user agent dliu-status-bot/1.0. Those requests are dropped before the logs are filed, so they never appear on the Bots page and are never scanned by Athena, judged by the bot check or looked up on AbuseIPDB. It also checks hourly from mainland China through Globalping (jsDelivr\'s free probe network), whose probes send a fixed user agent starting with globalping probe; those are dropped the same way (anyone else\'s Globalping tests are synthetic too, so they go as well).'));

root.append(callout('browser', t('浏览器名称绝不会被用来判定访客。微信、QQ 浏览器、360、UC、夸克、华为、搜狗等在中国流行的浏览器，以及各类应用内浏览器，都与 Chrome 或 Safari 一视同仁：只看它们的实际行为。', 'The browser name is never used against a visitor. WeChat, QQ Browser, 360, UC, Quark, Huawei, Sogou and other browsers popular in China, as well as in-app browsers everywhere, are treated exactly like Chrome or Safari: only what they do counts.')));

add('h2', t('运行时间', 'When it runs'));
root.append(tiers({
  title: t('机器人检查', 'Bot check'),
  rows: [
    {
      label: t('触发', 'Trigger'), badge: t('每 6 小时', 'Every 6 hours'), tone: 'edge',
      nodes: [
        { icon: 'clock', title: t('定时', 'Schedule'), text: t('EventBridge 在 UTC 00:30、06:30、12:30 和 18:30 触发，出错时重试两次；若另一次检查正在运行则跳过', 'EventBridge at 00:30, 06:30, 12:30 and 18:30 UTC, retried twice on error; skipped while another check is running') },
        { icon: 'user', title: t('立即检查机器人', 'Check bots now'), text: t('机器人页面上的按钮；立即执行同样的检查', 'Button on the Bots page; the same check, straight away') },
      ],
    },
    {
      label: t('机器人检查 Lambda', 'Bot check Lambda'), badge: t('最长 15 分钟', 'Up to 15 min'), tone: 'app', link: t('启动', 'starts'),
      nodes: [
        { icon: 's3', title: t('只读新日志文件', 'New log files only'), text: t('把每个之前未读过的文件累加到按日期和 IP 统计的计数中：请求数、浏览器请求数、网络、扫描路径、页面加载', 'Adds each file not read before to running counts per day and IP: requests, browser requests, network, scanned paths, page loads') },
        { icon: 'shield', title: 'AbuseIPDB', text: t('查询仍然像真人的 IP', 'Looks up IPs that still look like people') },
        { icon: 'filter', title: t('规则', 'Rules'), text: t('为每个 IP 的每一天选出第一个匹配的原因', 'Picks the first matching reason for each IP and day') },
      ],
    },
    {
      label: t('日志存储桶', 'Log bucket'), badge: t('私有', 'Private'), tone: 'private', link: t('写入', 'writes'),
      nodes: [
        { icon: 's3', title: 'bots/dt=<day>/', text: t('每天一个文件，列出当天的机器人及原因；每次运行都会替换', 'One file per day listing its bots and why; replaced on every run') },
        { icon: 's3', title: 'reputation/dt=<day>/', text: t('AbuseIPDB 结果，保留 180 天', 'AbuseIPDB results, kept 180 days') },
        { icon: 's3', title: 'bot-state/', text: t('每天的计数和已读文件（保留一周），以及每个 IP 最新的 AbuseIPDB 结果', 'The counts and the files already read, per day (kept a week), and the latest AbuseIPDB result per IP') },
      ],
    },
    {
      label: t('仪表板', 'Dashboard'), badge: t('需登录', 'Sign-in'), tone: 'app', link: t('按日期和 IP 关联', 'joined by day and IP'),
      nodes: [
        { icon: 'chart', title: t('所有组件', 'Every widget'), text: t('除非勾选“包括机器人”，否则不计入机器人', 'Leaves bots out unless Include bots is ticked') },
        { icon: 'page', title: t('IP 页面', 'IP page'), text: t('显示该 IP 被判为机器人的原因及其 AbuseIPDB 结果', 'Shows why an IP counts as a bot and its AbuseIPDB result') },
      ],
    },
  ],
  note: t('每次运行都会根据保存的计数重新判定今天及前 3 天，因此迟到的 AbuseIPDB 结果或新列入的托管网络仍能修正判定。每条日志记录只读一次，每个 IP 在 30 天内只查询一次。之后，每日日志合并会永久删除机器人的请求。', 'Each run re-judges today and the 3 days before from the saved counts, so a late AbuseIPDB result or a newly listed hosting network still corrects them. No log record is read twice and no IP is looked up twice within 30 days. After that the daily log merge deletes the bots\' requests for good.'),
}));
list([
  t('在检查覆盖之前，新流量都算作真人，带爬虫 User-Agent 的请求除外。最多 6 小时的延迟属于正常情况。', 'New traffic counts as people until a check has covered it, except requests with a crawler user agent. A delay of up to 6 hours is expected.'),
  t('机器人页面上的“立即检查机器人”会立即执行同样的检查，大约需要一分钟，完成后页面会重新加载。同一时间只运行一次检查。', 'Check bots now, on the Bots page, runs the same check straight away. It takes about a minute; the page reloads when it finishes. Only one check runs at a time.'),
  t('仪表板不计入机器人。机器人页面（需登录）显示任意时段内机器人的请求、IP 和 User-Agent；AbuseIPDB 检查页面显示查询额度的使用情况。', 'The dashboards leave bots out. The Bots page (signed in) shows their requests, IPs and user agents for any period; the AbuseIPDB check page shows how the lookups were used.'),
  t('每天 UTC 01:30，日志合并会把检查已完成的每一天（4 天前）合并为每个网站一个文件，按月存放（archive/month=YYYY-MM/），并永久删除机器人的请求，因此机器人记录只存在于今天及前 3 天。', 'At 01:30 UTC the log merge turns each day the check has finished with (4 days ago) into one file per site in a folder per month (archive/month=YYYY-MM/) and deletes the bots\' requests for good, so bot records exist only for today and the 3 days before.'),
  t('判定按天进行：昨天被判为机器人的 IP，今天会重新判定，因为家庭和移动网络的 IP 会易手。', 'Verdicts are per day: an IP that was a bot yesterday is judged afresh today, because home and mobile IPs change hands.'),
]);

add('h2', t('AbuseIPDB 及其每日限额', 'AbuseIPDB and its daily limit'));
add('p', t('AbuseIPDB 免费套餐每天允许 1,000 次查询，在 UTC 午夜重置。检查会精打细算地使用这些额度：', 'The free AbuseIPDB plan allows 1,000 lookups a day, reset at midnight UTC. The check spends them carefully:'));
root.append(table([t('规则', 'Rule'), t('效果', 'Effect')], [
  [t('只查可能的真人', 'Only possible people'), t('已被其他规则识别的 IP，或从未使用浏览器 User-Agent 的 IP，不会查询', 'IPs already caught by another rule, or that never used a browser user agent, are not looked up')],
  [t('每 30 天一次', 'Once per 30 days'), t('无论出现在多少天、多少网站或多少次运行中，每个 IP 最多查询一次，30 天后才会再次查询。查询一结束就保存结果，保留 180 天', 'Each IP is looked up at most once, however many days, sites or runs it appears in; it is looked up again only after 30 days. Results are saved as soon as the lookups end, and kept for 180 days')],
  [t('最新、最活跃的优先', 'Newest and busiest first'), t('最近一天的 IP 优先；同一天内，请求最多的 IP 优先', 'IPs from the latest day go first, the busiest ones first within a day')],
  [t('当天各次运行共用', 'Shared by the day\'s runs'), t('每次运行使用当天之前各次运行剩下的额度（共 1,000 次）；一旦某次运行达到限额，当天其余运行都不再查询', 'Each run uses what the day\'s earlier runs left of the 1,000; once one hits the limit, the rest of the day\'s runs look nothing up')],
  [t('达到限额即停止', 'Stops at the limit'), t('当 AbuseIPDB 返回 429 或表示额度已用完时，本次运行停止查询，保存已有结果，并据此标记机器人', 'When AbuseIPDB answers 429 or says no lookups are left, the run stops looking up, saves what it has and flags with the results it already has')],
  [t('稍后补查', 'Catches up later'), t('未查询的 IP 会等待下一次仍有额度的运行，前提是它们最近出现的日期仍在最近 3 天内；超过之后就不再查询，算作真人', 'IPs that were not looked up wait for the next run with lookups left, while their newest day is within the last 3 days; after that they are dropped and count as people')],
]));
add('p', t('发送给 AbuseIPDB 的只有 IP 地址，绝不包括访客 ID、页面或 User-Agent。API 密钥加密存储在 SSM Parameter Store 中。即使没有密钥，检查仍会运行其他所有规则。', 'Only the IP address is sent to AbuseIPDB, never the visitor ID, page or user agent. The API key is stored encrypted in SSM Parameter Store. Without a key, the check still runs every other rule.'));

add('h2', t('局限', 'Limits'));
list([
  t('使用真实浏览器、加载所有文件并来自家庭或移动网络的机器人，看起来就像真人。', 'A bot that runs a real browser, loads every file and comes from a home or mobile network looks like a person.'),
  t('同一 IP 背后的多个人（办公室、学校或移动运营商 NAT）当天共用同一个判定结果。', 'Several people behind one IP (an office, a school or mobile carrier NAT) share one verdict for the day.'),
  t('屏蔽脚本和 Cookie 且只访问一次的人，可能会被算作从不加载页面。', 'A person who blocks scripts and cookies and visits only once may count as never loading a page.'),
  t('托管网络列表和 AbuseIPDB 都可能出错；IP 页面会显示原因，便于核查。', 'The hosting list and AbuseIPDB can be wrong; the IP page shows the reason so it can be checked.'),
]);

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
detailList(t('数据', 'Data'), [
  t('Glue 表 bot_ips（ip、reason）和 ip_reputation（ip、score、reports、usage_type、isp、domain、is_tor、checked），均为按天分区的换行分隔 JSON，并使用分区投影。', 'Glue tables bot_ips (ip, reason) and ip_reputation (ip, score, reports, usage_type, isp, domain, is_tor, checked), both newline-delimited JSON partitioned by day with partition projection.'),
  t('仪表板查询会按日期和 IP 对所选时段 LEFT JOIN bot_ips；爬虫 User-Agent 规则在同一查询中应用。', 'Dashboard queries LEFT JOIN bot_ips on day and IP for the chosen period; the crawler user agent rule is applied in the same query.'),
  t('机器人判定结果一年后删除。机器人自身的请求在满 4 天后由每日日志合并删除。', 'Bot verdicts are deleted after a year. The bots\' own requests are deleted by the daily log merge once a day is 4 days old.'),
  t('每次运行都会把 AbuseIPDB 计数（按日志日期：出现、真人、近期已查、已查询、剩余、滥用）写入 abuseipdb/runs/，保留 120 天，供 AbuseIPDB 检查页面使用。', 'Each run writes its AbuseIPDB counts (per log day: seen, people, checked recently, looked up, left, abusive) to abuseipdb/runs/, kept 120 days, for the AbuseIPDB check page.'),
  t('托管网络列表每周一根据两份公开的 ASN 列表加上内置的核心列表重新生成，存放在日志存储桶中。因为机器人的请求会被永久删除，列出大型家庭宽带或移动运营商的列表会被跳过，一次更新最多新增 300 个网络。', 'The hosting list is rebuilt every Monday from two public ASN lists plus a built-in core, and stored in the log bucket. Because bots\' requests are deleted for good, a list naming a big home broadband or mobile network is skipped, and one update may add at most 300 networks.'),
  t('运行状态（运行中、已完成或失败，以及计数）保存在 bots/status.json 中；16 分钟后仍未完成的运行显示为失败。', 'The run status (running, done or failed, with counts) is kept in bots/status.json; a run that has not finished after 16 minutes is shown as failed.'),
]);
detailList(t('命令', 'Commands'), [
  t('make classify-bots 立即检查今天及最近 DAYS 天（默认 3，最多 7；更早的日期已经合并，没有可检查的内容）。', 'make classify-bots runs the check now for today and the last DAYS days (default 3, at most 7; older days have been merged, so there is nothing left to check).'),
  t('make compact-logs 立即合并日期；FROM=YYYY-MM-DD TO=YYYY-MM-DD 一次性合并更早的日期，DRY=1 只报告将要执行的操作，UNJUDGED=1 还会合并机器人检查上线之前的日期（只删除 agent 类机器人）。', 'make compact-logs merges days now; FROM=YYYY-MM-DD TO=YYYY-MM-DD merges older days once, DRY=1 only reports what it would do, UNJUDGED=1 also merges days from before the bot check (dropping agent bots only).'),
  t('make set-abuseipdb-key 将 AbuseIPDB 密钥存入 SSM，不会回显。', 'make set-abuseipdb-key stores the AbuseIPDB key in SSM without echoing it.'),
  t('机器人检查 Lambda 会为每次运行记录摘要：日期、IP、读取的日志文件、各原因的机器人数量，以及 AbuseIPDB 查询的已用和剩余次数。', 'The bot check Lambda logs a summary of each run: days, IPs, log files read, bots per reason and AbuseIPDB lookups used and left.'),
]);
details.append(document.createElement('h3'));
details.lastChild.textContent = t('延伸阅读', 'Further reading');
const links = document.createElement('ul');
for (const [href, text] of [
  ['https://docs.abuseipdb.com/#check-endpoint', t('AbuseIPDB check 接口', 'AbuseIPDB check endpoint')],
  ['https://www.abuseipdb.com/pricing', t('AbuseIPDB 套餐与每日限额', 'AbuseIPDB plans and daily limits')],
  ['https://github.com/brianhama/bad-asn-list', t('Bad ASN 列表', 'Bad ASN list')],
  ['https://github.com/X4BNet/lists_vpn', t('X4BNet VPN 与数据中心列表', 'X4BNet VPN and data centre lists')],
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
footer.textContent = t('源代码：dliu-com/traffic-monitor（lambda/dashboard/bots.js）。', 'Source: dliu-com/traffic-monitor (lambda/dashboard/bots.js).');
root.append(footer);
