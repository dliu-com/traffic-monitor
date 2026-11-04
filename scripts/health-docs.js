#!/usr/bin/env node
// Builds the testing instructions from config/health.json, so the two forms can never drift apart:
//   the Health tab in web/docs.html  -> /docs#health     (for people: diagram, plain words, technical details folded),
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
const ARROW = '<span class="dg-arrow"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg></span>';

const step = (iconName, title, text, tone) => `<div class="dg-step${tone ? ` dg-${tone}` : ''}" role="listitem"${iconName ? ` data-icon="${iconName}"` : ''}><span class="dg-text">${tr('strong', title)}${tr('small', text)}</span></div>`;

function expectText(check) {
  if (check.location) return [`Location 以 ${check.location} 开头`, `Location starts with ${check.location}`];
  if (check.jsonKey) return [`JSON 含键 "${check.jsonKey}"`, `JSON with key "${check.jsonKey}"`];
  return [`正文包含 "${check.marker}"`, `body contains "${check.marker}"`];
}

const tableHtml = (head, rows) => `<div class="table-wrap"><table>
<thead><tr>${head.map((h) => tr('th', h)).join('')}</tr></thead>
<tbody>
${rows.map((row) => `<tr>${row.map((cell) => (Array.isArray(cell) ? tr('td', cell) : `<td>${esc(cell)}</td>`)).join('')}</tr>`).join('\n')}
</tbody>
</table></div>`;

// What a person sees: high-level pages and endpoints only, no status codes, headers, content types or JSON.
const pageName = (p) => (p === '/' ? ['首页', 'home page'] : [p, p]);
function testedPaths(data, fn) {
  const paths = data.checks.filter((c) => c.function === fn.key).map((c) => pageName(c.path));
  if (fn.health) paths.push(['/health', '/health']);
  return [paths.map((x) => x[0]).join('、'), paths.map((x) => x[1]).join(', ')];
}
const checkCount = (data, fn) => data.checks.filter((c) => c.function === fn.key).length + (fn.health ? 1 : 0);

// A horizontal bar chart in SVG (attributes only: the CSP forbids inline styles).
function chart(data) {
  const rows = data.functions.map((f) => [f.name, checkCount(data, f)]);
  const max = Math.max(...rows.map(([, n]) => n));
  const rowHeight = 34;
  const height = rows.length * rowHeight;
  const bars = rows.map(([name, n], i) => {
    const y = i * rowHeight;
    const width = Math.round((n / max) * 360);
    return `<text class="axis" x="170" y="${y + 21}" text-anchor="end" data-zh="${esc(name[0])}">${esc(name[1])}</text>`
      + `<rect class="bar" x="180" y="${y + 6}" width="${width}" height="22" rx="4"/>`
      + `<text class="axis" x="${188 + width}" y="${y + 21}">${n}</text>`;
  }).join('\n        ');
  return `<figure class="dg chart health-chart">${tr('figcaption', ['每项功能有几项检查', 'How many checks each function has'])}
        <svg viewBox="0 0 600 ${height}" role="img" aria-label="Checks per function" data-zh-label="每项功能的检查数">
        ${bars}
        </svg>
      </figure>`;
}

function buildArticle(data) {
  const total = data.functions.reduce((sum, f) => sum + checkCount(data, f), 0);
  const places = data.places;
  const stat = (iconName, value, label) => `<div class="dg-stat" data-icon="${iconName}"><span class="dg-text">${tr('strong', value)}${tr('small', label)}</span></div>`;
  const critical = data.functions.filter((f) => f.critical).map((f) => f.name);
  return `    <article id="health" class="dl-docs" hidden>
      <h2 data-zh="如何测试本网站">How this site is tested</h2>
      ${tr('p', data.intro, ' class="lead"')}

      <div class="dg-stats">
        ${[
    stat('check', [String(data.functions.length), String(data.functions.length)], ['项功能被测试', 'functions tested']),
    stat('filter', [String(total), String(total)], ['项检查', 'checks']),
    stat('clock', ['15 分钟', '15 min'], ['检查一次', 'between test runs']),
    stat('pin', [String(places.length), String(places.length)], [`个地点：${places.map((x) => x[0]).join('、')}`, `places: ${places.map((x) => x[1]).join(', ')}`]),
  ].join('\n        ')}
      </div>

      <figure class="dg">${tr('figcaption', ['一次测试怎么进行', 'How a test run goes'])}<div class="dg-flow" role="list">
        ${[
    step('eye', ['status.dliu.com', 'status.dliu.com'], [`以游客身份，从${places.map((x) => x[0]).join('、')}`, `As a guest, from ${places.map((x) => x[1]).join(', ')}`]),
    step('browser', ['打开公开页面', 'Opens the public pages'], ['首页、文档、公开数字、小脚本和“登录”按钮', 'Home page, docs, public numbers, the small script and the Sign in button']),
    step('lambda', ['请网站检查自己', 'Asks the site to check itself'], ['/health 查看存储、登录设置和定时任务', '/health looks at its storage, sign-in settings and scheduled jobs']),
    step('chart', ['记下结果', 'Records the result'], ['每项功能一个结果，显示在 status.dliu.com', 'One result per function, shown on status.dliu.com']),
  ].join(`\n        ${ARROW}\n        `)}
      </div></figure>

      <figure class="dg">${tr('figcaption', ['每项检查的结果', 'What each result means'])}<div class="dg-flow dg-results" role="list">
        ${step('check', ['正常', 'Working'], ['一切如常', 'Everything as expected'], 'good')}
        ${step('clock', ['变慢或变旧', 'Slow or out of date'], ['还能用，但慢了或数据旧了', 'Still works, but slow or showing old data'], 'warn')}
        ${step('shield', ['故障', 'Not working'], ['访客会注意到', 'Visitors notice'], 'bad')}
      </div></figure>

      <h2 data-zh="测试的功能">Functions tested</h2>
${tableHtml(
    [['功能', 'Function'], ['✓ 正常时', '✓ When it works'], ['怎么测试', 'How it is tested'], ['测试的页面和接口', 'Pages and endpoints tested'], ['✗ 出故障时访客会注意到', '✗ If it stopped working, a visitor would notice']],
    data.functions.map((f) => [f.name, f.what, f.tested, testedPaths(data, f), f.down]),
  )}
      ${tr('p', [`“${critical.map((x) => x[0]).join('”或“')}”出故障时，整个网站算作宕机；其他功能出故障时，网站算作部分可用。`, `The site counts as down when ${critical.map((x) => x[1]).join(' or ')} stops working; when anything else stops working it counts as partly working.`])}

      ${chart(data)}

      <h2 data-zh="没有测试的内容">What isn't tested</h2>
      <ul>
${data.untested.map((item) => `        ${tr('li', item.plain)}`).join('\n')}
      </ul>

      <p><a href="/docs/health.md" data-zh="给机器读的技术版本（Markdown）">Technical version for machines (Markdown)</a></p>
    </article>`;
}

function healthExample(data) {
  return JSON.stringify({
    status: 'pass',
    time: '2026-11-03T23:00:00Z',
    functions: data.functions.filter((f) => f.health).map((f) => ({ key: f.key, name: f.name[1], status: 'pass' })),
  }, null, 2);
}

const START = '<!-- health:start Generated by scripts/health-docs.js from config/health.json; edit those, not this block. -->';
const END = '<!-- health:end -->';

// Puts the Health tab into docs.html between the markers.
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

- Human version: ${data.site}/docs#health (the Health tab)
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

${data.untested.map((item) => `- ${item.detail}`).join('\n')}

## Rules

- The tests are read only and must never change content: \`GET\` or \`HEAD\` only.
- Never send \`POST\` to \`/t/e\` (it would be recorded as a visit) or to \`/api/\`.
- traffic.dliu.com drops requests whose user agent starts with \`dliu-status-bot/\` or \`globalping probe\` (the
  hourly checks from mainland China through Globalping) from its logs, so the tests never count as traffic.
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
  console.log('Wrote the Health tab in web/docs.html and web/docs-health.md');
}

module.exports = { build, HTML_FILE, MD_FILE };
