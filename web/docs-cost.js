import { flow, stats, table, callout } from './diagram.js';
import { t } from './i18n.js';

const root = document.getElementById('cost');

function add(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  root.append(node);
  return node;
}

const num = (text) => ({ text, className: 'num' });

root.append(stats([
  ['≈ $0.26', t('整个监控系统每月的费用', 'per month for the whole monitor'), 'budget'],
  ['$0', t('游客（未登录）每次页面加载（预先计算好的文件）', 'per guest page load (pre-computed files)'), 'shield'],
  ['≈ $0.005', t('已登录用户每次加载仪表板页面', 'per signed-in dashboard page load'), 'athena'],
]));

add('h2', t('每月账单', 'Monthly bill'));
add('p', t('无人使用仪表板时监控系统的费用：记录每个网站的每次请求、每日任务，以及游客读取的文件。', 'What the monitor costs with nobody using the dashboard: recording every request to every site, the daily jobs and the files guests read.'));
root.append(table([t('组成部分', 'Part'), t('计费方式', 'How it is billed'), t('一般月份', 'Typical month')], [
  [t('S3 请求', 'S3 requests'), t('每月约 11,000 个日志文件（每天约 350 个）；每个文件写入、读取、归档和删除各一次（每 1,000 次写入 $0.005）', 'About 11,000 log files a month (about 350 a day); each is written, read, filed and deleted once ($0.005 per 1,000 writes)'), num('≈ $0.11')],
  [t('公开统计', 'Public statistics'), t('每天 02:00 UTC 运行三次 Athena 查询，生成游客看到的 7、30 和 90 天总计', 'Three Athena queries a day, at 02:00 UTC, write the 7, 30 and 90-day totals guests see'), num('≈ $0.08')],
  [t('机器人检查 Lambda', 'Bot check Lambda'), t('每 6 小时一次，另加“立即检查机器人”；每次运行只读取之前任何一次运行都没读过的日志文件，不运行 Athena 查询；配置 1 GB 内存以容纳城市数据库', 'Every 6 hours, plus Check bots now; each run reads only the log files no earlier run has read, with no Athena query; 1 GB of memory to hold the city database'), num('≈ $0.04')],
  [t('每日日志合并', 'Daily log merge'), t('每天 01:30 UTC 把每个网站一天的日志合并为一个文件，按月分文件夹存放，并删除机器人的请求', 'At 01:30 UTC merges each site\'s day into one file in a folder per month and deletes bots\' requests'), num('≈ $0.01')],
  [t('S3 存储、CloudWatch 日志、每周托管网络列表', 'S3 storage, CloudWatch logs, weekly hosting list'), t('gzip 压缩后的日志每月约 25 MB，保留一年；Lambda 日志保留 90 天', 'Gzipped logs of about 25 MB a month, kept for one year; Lambda logs kept 90 days'), num('≈ $0.01')],
  [t('DB-IP 城市数据库', 'DB-IP city database'), t('每月 2 日下载（在 S3 中保存约 130 MB），当某个 IP 没有 CloudFront 城市时由机器人检查读取', 'Downloaded on the 2nd of each month (about 130 MB kept in S3), and read by the bot check when an IP has no CloudFront city'), num('≈ $0.01')],
  [t('CloudFront 日志投递（标准日志 v2）', 'CloudFront log delivery (standard logging v2)'), t('投递到 S3 的日志每 GB $0.25；按目前的流量每月只有几 MB', '$0.25 per GB of log lines delivered to S3; a few MB a month at this traffic'), num('< $0.01')],
  [t('访客 ID 函数', 'Visitor ID function'), t('每百万次网站请求 $0.10', '$0.10 per million site requests'), num('< $0.01')],
  [t('页面脚本（加载它的网站）', 'Page script (sites that load it)'), t('由 CloudFront Function 提供并记录（每百万次 $0.10）；每次浏览最多 8 条小型上报，以 JSON 行记录', 'Served and logged by a CloudFront Function ($0.10 per million); up to 8 small reports per page view, logged as JSON lines'), num('< $0.01')],
  [t('分区器 Lambda', 'Partitioner Lambda'), t('每个日志文件一次短调用', 'One short call per log file'), num(t('$0（免费套餐）', '$0 (free tier)'))],
  ['AbuseIPDB', t('免费套餐，每天最多 1,000 次查询', 'Free plan, up to 1,000 lookups a day'), num('$0')],
  [t('仪表板 Lambda、CloudFront、Glue、SSM', 'Dashboard Lambda, CloudFront, Glue, SSM'), t('按请求计费，或在此规模下免费', 'Per request, or free at this size'), num('$0')],
  [t('合计', 'Total'), t('尚无人登录时', 'Before anyone signs in'), num('≈ $0.26')],
]));

add('h2', t('每次页面加载', 'Per page load'));
add('p', t('未登录的游客读取的是预先计算好的文件，因此游客浏览从不触发查询，无论多少次都不产生费用。已登录用户的页面实时查询 Athena；每个组件各自运行查询，每个页面约 6 个。', 'Guests read pre-computed files, so a guest visit never starts a query and costs nothing however many there are. Signed-in pages query Athena live; each widget runs its own query, about 6 per page.'));
root.append(table([t('用户', 'Who'), t('时段', 'Period'), t('读取内容', 'What it reads'), t('每次页面加载', 'Per page load')], [
  [t('游客', 'Guest'), t('7、30 或 90 天', '7, 30 or 90 days'), t('stats/7d.json、30d.json 或 90d.json，每天刷新', 'stats/7d.json, 30d.json or 90d.json, refreshed daily'), num('$0')],
  [t('已登录', 'Signed in'), t('24 小时、3 天', '24 hours, 3 days'), t('每日文件夹中最近几天的小文件', 'The newest days\' small files in daily folders'), num('≈ $0.004')],
  [t('已登录', 'Signed in'), t('7 或 30 天', '7 or 30 days'), t('上述文件，加上月份文件夹中每个网站每天一个的合并文件', 'Those, plus one merged file per site and day in a month folder'), num('≈ $0.005')],
  [t('已登录', 'Signed in'), t('90 天', '90 days'), t('上述文件，加上 4 个月份文件夹中约 660 个合并文件', 'Those, plus about 660 merged files in 4 month folders'), num('≈ $0.0065')],
]));
add('p', t('已登录用户加载 100 次页面约 $0.50，1,000 次约 $5。每次搜索或点击“显示更多”都会多运行一次查询。', 'About $0.50 for 100 signed-in page loads, $5 for 1,000. Each search or "Show more" runs one more query.'), 'dg-note');

add('h2', t('Athena 查询的费用从何而来', 'Why an Athena query costs what it does'));
add('p', t('Athena 按扫描量收费，每 TB $5，最低按 10 MB 计，即每次查询约 $0.00005；日志很小，所以每次查询都只付最低费用。真正的开销在 S3：Athena 会列出它读取的每个文件夹（每 1,000 次列出 $0.005），并读取其中的每个文件（每 1,000 次读取 $0.0004）。因此费用取决于查询涉及多少文件夹和文件，而不是其中有多少数据。', 'Athena charges $5 per TB scanned with a 10 MB minimum, about $0.00005 a query; the logs are small, so every query pays only the minimum. The real cost is S3: Athena lists every folder it reads ($0.005 per 1,000 lists) and reads every file in it ($0.0004 per 1,000 reads). So the bill depends on how many folders and files a query touches, not on how much data they hold.'));
root.append(table([t('存储布局', 'Layout'), t('90 天需列出的文件夹', 'Folders listed for 90 days'), t('90 天需读取的文件', 'Files read for 90 days')], [
  [t('每个网站每天一个文件夹，即 CloudFront 写入的方式', 'A folder per site and day, as CloudFront writes them'), t('≈ 720（+ 90 个机器人判定文件夹）', '≈ 720 (+ 90 bot verdict folders)'), '≈ 31,000'],
  [t('合并后：每个网站每天一个文件，按月分文件夹（当前采用）', 'Merged: one file per site and day, in a folder per month (used)'), t('≈ 4（+ 7 天的每日文件夹）', '≈ 4 (+ 7 daily days)'), t('≈ 660（+ 最近几天的小文件）', '≈ 660 (+ the newest days\' small files)')],
]));
root.append(callout('clock', t('最近 3 天的数据保留在每日文件夹中，包含所有请求（含机器人），以便机器人检查可以重新判定。现在一次查询的大部分费用就来自这几天的小文件：约 1,050 个。', 'The newest 3 days stay in daily folders with every request, bots included, so the bot check can judge them again. Most of what a query costs now is those days\' small files: about 1,050 of them.')));

root.append(flow({
  title: t('费用为何能保持很低', 'What keeps the bill small'),
  steps: [
    { icon: 'power', title: t('没有闲置服务器', 'No idle servers'), text: t('Lambda 和 Athena 只在使用时运行', 'Lambda and Athena run only when used') },
    { icon: 'page', title: t('游客看静态文件', 'Static for guests'), text: t('公开总计是文件，每天写入一次', 'Public totals are files, written once a day') },
    { icon: 'stack', title: t('按天合并', 'Merged days'), text: t('超过 3 天的数据每个网站合并为一个文件，按月分文件夹', 'Days older than 3 become one file per site, in a folder per month') },
    { icon: 'filter', title: t('分区', 'Partitions'), text: t('查询只读取所选的网站、日期和月份', 'Queries read only the chosen sites, days and months') },
    { icon: 'budget', title: t('扫描上限', 'Scan cap'), text: t('每次查询扫描满 1 GB 即停止', 'Each query stops at 1 GB scanned') },
    { icon: 'clock', title: t('结果复用', 'Result reuse'), text: t('5 分钟内的相同查询免费', 'The same query within 5 minutes is free') },
    { icon: 's3', title: t('生命周期', 'Lifecycle'), text: t('原始文件归档后删除（最长 1 天），日志 1 年后删除', 'Raw files deleted once filed (1 day at most), logs after 1 year'), tone: 'good' },
  ],
}));

add('p', t('价格按 2026 年 10 月 eu-west-1（爱尔兰）及 us-east-1 日志投递的标准计算。文件数量是在线上日志存储桶中实测的。不使用仪表板时，监控系统每年约 $3.10。费用随流量增长：每个网站每个繁忙的 5 分钟时段大约多一个日志文件，每多 1 GB 日志 $0.25，每多一百万次请求 $0.10。', 'Prices are for eu-west-1 (Ireland) and us-east-1 log delivery in October 2026. File counts were measured on the live log bucket. Without dashboard use the monitor costs about $3.10 a year. Costs grow with traffic: roughly one extra log file per site per busy 5-minute period, $0.25 per extra GB of logs and $0.10 per million requests.'), 'dg-note');

const footer = document.createElement('p');
footer.className = 'source';
footer.textContent = t('源代码：dliu-com/traffic-monitor（lib/traffic-monitor-stack.ts、lambda/dashboard/compact.js）。', 'Source: dliu-com/traffic-monitor (lib/traffic-monitor-stack.ts, lambda/dashboard/compact.js).');
root.append(footer);
