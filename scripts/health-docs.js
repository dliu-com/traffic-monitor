#!/usr/bin/env node
// Builds the testing instructions from config/health.json, so the two forms can never drift apart:
//   the Testing tab in web/docs.html  -> /docs#health     (for people: diagram, plain words, technical details folded),
//                                         written between the health:start and health:end markers
//   web/docs-health.md                -> /docs/health.md  (for machines: every technical detail, unfolded)
// The old /docs/health URL redirects to /docs#health (functions/dashboard-pages.js).
// Usage: node scripts/health-docs.js          write both
//        node scripts/health-docs.js --check  exit 1 if either is out of date (run by the tests)
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'config/health.json');
const HTML_FILE = path.join(ROOT, 'web/docs.html');
const MD_FILE = path.join(ROOT, 'web/docs-health.md');
const USER_AGENT = 'dliu-status-bot/1.0 (+https://status.dliu.com/docs)';

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// An element whose text switches language (i18n.js swaps in data-zh); it must hold plain text only.
const tr = (tag, [zh, en], attrs = '') => `<${tag}${attrs} data-zh="${esc(zh)}">${esc(en)}</${tag}>`;
const code = (text) => `<code>${esc(text)}</code>`;
const ARROW = '<span class="dg-arrow"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg></span>';

const step = (iconName, title, text, tone) => `<div class="dg-step${tone ? ` dg-${tone}` : ''}" role="listitem"${iconName ? ` data-icon="${iconName}"` : ''}><span class="dg-text">${tr('strong', title)}${tr('small', text)}</span></div>`;

function expectText(check) {
  if (check.location) return [`Location 以 ${check.location} 开头`, `Location starts with ${check.location}`];
  if (check.jsonKey) return [`JSON 含键 "${check.jsonKey}"`, `JSON with key "${check.jsonKey}"`];
  return [`正文包含 "${check.marker}"`, `body contains "${check.marker}"`];
}
// Mixed text and code in both languages: docs-health.js shows the reader's language (English without JavaScript).
const both = (tag, zh, en) => `<${tag} data-lang="en">${en}</${tag}>\n<${tag} data-lang="zh" hidden>${zh}</${tag}>`;

const tableHtml = (head, rows) => `<div class="table-wrap"><table>
<thead><tr>${head.map((h) => (Array.isArray(h) ? tr('th', h) : `<th>${esc(h)}</th>`)).join('')}</tr></thead>
<tbody>
${rows.map((row) => `<tr>${row.map((cell) => (Array.isArray(cell) ? tr('td', cell) : `<td>${cell}</td>`)).join('')}</tr>`).join('\n')}
</tbody>
</table></div>`;

const details = (summary, body) => `<details class="dg-more">${tr('summary', summary)}<div>
${body}
</div></details>`;

function healthExample(data) {
  return JSON.stringify({
    status: 'pass',
    time: '2026-11-03T23:00:00Z',
    functions: data.functions.filter((f) => f.health).map((f) => ({ key: f.key, name: f.name[1], status: 'pass' })),
  }, null, 2);
}

function buildArticle(data) {
  const withHealth = data.functions.filter((f) => f.health);
  const checks = tableHtml(
    [['功能', 'Function'], ['方法', 'Method'], ['网址', 'URL'], ['状态码', 'Status'], ['内容类型', 'Content type'], ['预期', 'Expect'], ['慢于', 'Slow after']],
    data.checks.map((c) => [code(c.function), 'GET', code(data.site + c.path), code(String(c.status)), c.type ? code(c.type) : '—', expectText(c), `${c.slowMs} ms`]),
  );
  const endpoint = `${both('ul', `
<li>${code('GET ' + data.site + '/health')}（也可用 HEAD），无需登录。</li>
<li>CloudFront 不转发 Cookie、${code('Authorization')} 请求头和查询字符串，处理程序也不读取它们。</li>
<li>在 CloudFront 缓存 60 秒（${code('cache-control: public, max-age=60')}），所以无论请求多频繁，每分钟最多检查一次。</li>
<li>只读：每个依赖一次低成本读取；不写入、不列出 S3、不运行 Athena 查询、不调用 AbuseIPDB。</li>
<li>每项检查 2 秒超时，整个响应在 5 秒内返回。</li>
<li>${code('Content-Type: application/health+json')}；${code('pass')} 或 ${code('warn')} 时 HTTP 200，${code('fail')} 时 503。</li>
<li>${code('output')} 只是简短原因，如 ${code('timeout')}、${code('read failed')} 或 ${code('stale')}，不含名称、数量或用户数据。</li>
`, `
<li>${code('GET ' + data.site + '/health')} (HEAD also works), no sign-in.</li>
<li>CloudFront forwards no cookies, no ${code('Authorization')} header and no query string, and the handler reads none of them.</li>
<li>Cached 60 s at CloudFront (${code('cache-control: public, max-age=60')}), so the checks run at most about once a minute however often it is requested.</li>
<li>Read only: one cheap read per dependency; no writes, no S3 LIST, no Athena query and no AbuseIPDB call.</li>
<li>Each check times out after 2 s; the whole response returns within 5 s.</li>
<li>${code('Content-Type: application/health+json')}; HTTP 200 for ${code('pass')} or ${code('warn')}, 503 for ${code('fail')}.</li>
<li>${code('output')} is only a short reason such as ${code('timeout')}, ${code('read failed')} or ${code('stale')}, with no names, counts or user data.</li>
`)}
<pre><code>${esc(healthExample(data))}</code></pre>
${tableHtml(
    [['键', 'Key'], ['读取内容', 'What it reads'], ['正常', 'pass'], ['警告', 'warn'], ['故障', 'fail']],
    withHealth.map((f) => [code(f.key), f.health.reads, f.health.pass, f.health.warn, f.health.fail]),
  )}`;
  const rules = both('ul', `
<li>只用 ${code('GET')} 或 ${code('HEAD')}，不带 Cookie，用户代理为 ${code(USER_AGENT)}；traffic.dliu.com 会从日志中丢弃这个用户代理的请求。</li>
<li>不要向 ${code('/t/e')} 或 ${code('/api/')} 发送 ${code('POST')}；测试只读，从不改变任何内容。</li>
<li>不要跟随 ${code('/auth/login')} 的跳转，只检查状态码和 ${code('Location')}。</li>
`, `
<li>Requests are ${code('GET')} or ${code('HEAD')} only, with no cookies and the user agent ${code(USER_AGENT)}; traffic.dliu.com drops that user agent from its logs.</li>
<li>Never send ${code('POST')} to ${code('/t/e')} or ${code('/api/')}; the tests are read only and never change anything.</li>
<li>Don't follow the ${code('/auth/login')} redirect; check only its status and ${code('Location')}.</li>
`);

  return `    <article id="health" class="dl-docs" hidden>
      <h2 data-zh="如何测试本网站">How this site is tested</h2>
      ${tr('p', data.intro, ' class="lead"')}

      <figure class="dg">${tr('figcaption', ['status.dliu.com 如何测试本网站', 'How status.dliu.com tests this site'])}<div class="dg-flow" role="list">
        ${[
    step('eye', ['status.dliu.com', 'status.dliu.com'], ['以游客身份，每 15 分钟', 'As a guest, every 15 minutes']),
    step('browser', ['公开页面和网址', 'Public pages and URLs'], ['仪表板、文档、公开统计、页面脚本、登录跳转', 'Dashboard, docs, public statistics, page script, sign-in redirect']),
    step('lambda', ['/health', '/health'], ['逐项检查后台功能', 'Checks each behind-the-scenes function']),
    step('s3', ['每项功能依赖的服务', 'What each function depends on'], ['登录设置、日志整理记录、机器人检查和统计文件', 'Sign-in settings, the log partitioner\'s record, the bot check and statistics files']),
  ].join(`\n        ${ARROW}\n        `)}
      </div></figure>

      <figure class="dg">${tr('figcaption', ['每项检查的结果', 'What each result means'])}<div class="dg-flow dg-results" role="list">
        ${step('check', ['正常', 'Pass'], ['一切如常', 'Working as expected'], 'good')}
        ${step('clock', ['警告', 'Warn'], ['还能用，但变慢或变旧', 'Still works, but slow or out of date'], 'warn')}
        ${step('shield', ['故障', 'Fail'], ['访客会受影响', 'Visitors are affected'], 'bad')}
      </div></figure>

      <h2 data-zh="检查的功能">Functions checked</h2>
${tableHtml(
    [['功能', 'Function'], ['检查什么', 'What is checked'], ['出故障时', 'If it is down']],
    data.functions.map((f) => [f.name, f.what, f.down]),
  )}
      <p data-zh="“页面”和“请求记录”出故障时，整个网站算作宕机；其他功能出故障时，网站算作部分可用。">The site counts as down when Pages or Request logging fails; when another function fails it counts as degraded.</p>

      ${details(['技术细节：游客检查', 'Technical details: guest checks'], checks)}
      ${details(['技术细节：/health 接口', 'Technical details: the /health endpoint'], endpoint)}
      ${details(['技术细节：测试规则', 'Technical details: rules for the tests'], rules)}

      <h2 data-zh="没有测试的内容">What isn't tested</h2>
      <ul>
${data.untested.map((item) => `        ${tr('li', item)}`).join('\n')}
      </ul>

      <p><a href="/docs/health.md" data-zh="完整技术版本（Markdown）">Full technical version (Markdown)</a></p>
    </article>`;
}

const START = '<!-- health:start Generated by scripts/health-docs.js from config/health.json; edit those, not this block. -->';
const END = '<!-- health:end -->';

// Puts the Testing tab into docs.html between the markers.
function splice(docs, article) {
  const from = docs.indexOf(START);
  const to = docs.indexOf(END);
  if (from < 0 || to < from) throw new Error('web/docs.html has no health:start / health:end markers');
  return `${docs.slice(0, from)}${START}\n${article}\n    ${docs.slice(to)}`;
}

const mdTable = (head, rows) => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => ' --- ').join('|')}|`,
  ...rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, '\\|')).join(' | ')} |`),
].join('\n');

function buildMd(data) {
  const en = (pair) => pair[1];
  const withHealth = data.functions.filter((f) => f.health);
  return `# traffic.dliu.com health checks

<!-- Generated by scripts/health-docs.js from config/health.json; the same content as ${data.site}/docs#health. -->

${en(data.intro)}

- Human version: ${data.site}/docs#health (the Testing tab)
- Contract: every dliu.com site follows the health contract of status.dliu.com (https://status.dliu.com/docs).

## Functions

The site is **down** when a critical function fails, and **degraded** when any other function fails.

${mdTable(['Key', 'Name', 'Critical', 'What is checked', 'If it is down'],
    data.functions.map((f) => [`\`${f.key}\``, en(f.name), f.critical ? 'yes' : 'no', en(f.what), en(f.down)]))}

## Guest checks

Send each request as a guest: method \`GET\` (\`HEAD\` also works), no cookies, no \`Authorization\` header, user agent
\`${USER_AGENT}\`, and do not follow redirects. A check passes when the status code matches, the \`Content-Type\` starts
with the given type, and the expectation holds. Slower than "Slow after" counts as slow (degraded).

${mdTable(['Function', 'Method', 'URL', 'Status', 'Content type', 'Expect', 'Slow after'],
    data.checks.map((c) => [`\`${c.function}\``, 'GET', data.site + c.path, c.status, c.type ? `\`${c.type}\`` : '—', expectText(c)[1], `${c.slowMs} ms`]))}

## Health endpoint

- URL: \`GET ${data.site}/health\` (\`HEAD\` also works). Outside \`/api/\`; no sign-in.
- CloudFront's \`/health\` behavior forwards no cookies, no \`Authorization\` header and no query string to the origin,
  and the handler (lambda/dashboard/health.js) reads none of them.
- Cached for 60 s at CloudFront (cache policy keyed on nothing; the response says \`cache-control: public, max-age=60\`),
  so the checks run at most about once a minute however often \`/health\` is requested.
- Read only: one cheap read per dependency, no writes, no S3 LIST, no Athena query and no AbuseIPDB call.
- Each check has its own 2 s timeout; the whole response returns within 5 s.
- \`Content-Type: application/health+json\`. HTTP \`200\` when \`status\` is \`pass\` or \`warn\`, \`503\` when it is \`fail\`.
  The top-level \`status\` is the worst of the functions'.
- \`output\` appears only when a function is not \`pass\`, and is a short generic reason: \`timeout\`, \`read failed\`,
  \`stale\`, \`last run failed\` or \`no recent logs\`. No names, counts or user data are returned.

Example:

\`\`\`json
${healthExample(data)}
\`\`\`

${mdTable(['Key', 'Name', 'What it reads', 'pass', 'warn', 'fail'],
    withHealth.map((f) => [`\`${f.key}\``, en(f.name), en(f.health.reads), en(f.health.pass), en(f.health.warn), en(f.health.fail)]))}

The \`pages\` and \`page-script\` functions have no \`/health\` entry; the guest checks above cover them.

## Not tested

${data.untested.map((item) => `- ${en(item)}`).join('\n')}

## Rules

- The tests are read only and must never change content: \`GET\` or \`HEAD\` only.
- Never send \`POST\` to \`/t/e\` (it would be recorded as a visit) or to \`/api/\`.
- traffic.dliu.com drops requests whose user agent starts with \`dliu-status-bot/\` from its logs, so the tests never
  count as traffic.
`;
}

function build() {
  const data = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  const article = buildArticle(data);
  return { article, html: splice(fs.readFileSync(HTML_FILE, 'utf8'), article), md: buildMd(data), data };
}

if (require.main === module) {
  const { html, md } = build();
  if (process.argv.includes('--check')) {
    const stale = [[HTML_FILE, html], [MD_FILE, md]].filter(([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text);
    for (const [file] of stale) console.error(`${path.relative(ROOT, file)} is out of date: run node scripts/health-docs.js`);
    process.exit(stale.length ? 1 : 0);
  }
  fs.writeFileSync(HTML_FILE, html);
  fs.writeFileSync(MD_FILE, md);
  console.log('Wrote the Testing tab in web/docs.html and web/docs-health.md');
}

module.exports = { build, HTML_FILE, MD_FILE };
