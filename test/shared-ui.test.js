// Every page uses the shared dliu.com look (https://files.dliu.com/dliu.com/README.md):
// dl.css first, the app's own logo (web/logo.svg) top left and as favicon, the DL logo in the footer,
// the shared header and footer, the ☰ menu on the dashboard pages, dl-docs.css and dl-tabs on the docs pages,
// and style.css keeps only the dashboard's own rules on the shared --dl-* colours.
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const DL_CSS = '<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl.css">';
const DOCS_CSS = '<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl-docs.css">';
const DL_ICON = 'https://files.dliu.com/dliu.com/favicon.png';
const APP_PAGES = ['index', 'site', 'page', 'visitor', 'ip', 'bots', 'abuse-check'];
const DOCS_PAGES = ['docs'];
const DOCS_TABS = ['architecture', 'bot-detection', 'cost', 'security'];
const ALL_PAGES = [...APP_PAGES, ...DOCS_PAGES];
// The shared docs tab names (https://files.dliu.com/dliu.com/README.md), in Chinese and English.
const TAB_NAMES = {
  architecture: ['技术架构', 'Technical architecture'],
  'bot-detection': ['机器人识别', 'Bot detection'],
  cost: ['成本', 'Cost'],
  security: ['安全', 'Security'],
};

test('the web folder has exactly these pages', () => {
  const pages = fs.readdirSync(path.join(__dirname, '..', 'web')).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5));
  expect(pages.sort()).toEqual([...ALL_PAGES].sort());
});

test.each(ALL_PAGES)('%s loads the shared stylesheet first and has the shared header and footer', (name) => {
  const page = read(`web/${name}.html`);
  const own = page.indexOf('<link rel="stylesheet" href="/style.css">');
  expect(page).toContain('<link rel="icon" href="/logo.svg" type="image/svg+xml">');
  expect(page).toContain(DL_CSS);
  expect(own).toBeGreaterThan(page.indexOf(DL_CSS));
  expect(page).toContain('<body class="dl-page">');
  expect(page).toContain('<header class="dl-header">');
  expect(page).toContain(`<a class="dl-brand" href="/"><img class="dl-logo" src="/logo.svg" alt="" width="32" height="32"><span data-zh="DL 流量">DL Traffic</span></a>`);
  expect(page).toMatch(/<nav (id="dl-menu" )?class="dl-nav( dl-nav-collapsible)?" aria-label="Site" data-zh-label="网站">/);
  expect(page).toMatch(/<main class="dl-main[" ]/);
  expect(page).toContain(`<footer class="dl-footer"><a class="dl-footer-logo" href="https://dliu.com" aria-label="dliu.com"><img src="${DL_ICON}" alt="" width="24" height="24"></a> <a href="https://dliu.com">dliu.com</a>`);
  expect(page).not.toContain('/about.css');
});

test.each(APP_PAGES)('%s has the ☰ menu just before the nav', (name) => {
  expect(read(`web/${name}.html`)).toContain('<button type="button" class="dl-button dl-menu-toggle" aria-controls="dl-menu" aria-expanded="false" aria-label="Menu" data-zh-label="菜单">☰</button>\n    <nav id="dl-menu" class="dl-nav dl-nav-collapsible" aria-label="Site" data-zh-label="网站">');
});

test('dash.js opens and closes the ☰ menu', () => {
  const dash = read('web/dash.js');
  expect(dash).toContain("nav.classList.toggle('is-open', open)");
  expect(dash).toContain("toggle.setAttribute('aria-expanded', String(open))");
  expect(dash).toContain("event.key === 'Escape'");
});

test.each(APP_PAGES)('%s keeps the ids the scripts use, with the shared sign-in buttons', (name) => {
  const page = read(`web/${name}.html`);
  for (const id of ['account', 'user', 'signin', 'signin-link', 'status', 'page']) expect(page).toContain(`id="${id}"`);
  expect(page).toContain('<span id="user" class="dl-account">');
  expect(page).toContain('<a class="dl-button" href="/auth/logout" data-zh="退出登录">Sign out</a>');
  expect(page).toContain('<a id="signin-link" class="dl-button dl-signin" href="/auth/login" hidden data-zh="登录">Sign in</a>');
  expect(page).toContain('<a class="dl-ms-signin" href="/auth/login">');
  expect(page).toContain('<section id="signin" hidden class="dl-card signin">');
});

test.each(DOCS_PAGES)('%s uses the shared docs stylesheet and tabs', (name) => {
  const page = read(`web/${name}.html`);
  expect(page.indexOf(DOCS_CSS)).toBeGreaterThan(page.indexOf(DL_CSS));
  expect(page.indexOf(DOCS_CSS)).toBeLessThan(page.indexOf('<link rel="stylesheet" href="/style.css">'));
  expect(page).toContain('<main class="dl-main dl-docs-main">');
  expect(page).toContain('<nav class="dl-tabs" aria-label="Docs sections" data-zh-label="文档章节">');
  for (const tab of DOCS_TABS) {
    expect(page).toContain(`<a href="#${tab}" data-tab="${tab}" data-zh="${TAB_NAMES[tab][0]}">${TAB_NAMES[tab][1]}</a>`);
    expect(page).toMatch(new RegExp(`<article id="${tab}" class="dl-docs"( hidden)?>`));
  }
  expect(page).toContain('<a class="dl-button" href="/docs" aria-current="page" data-zh="文档">Docs</a>');
});

test('the dashboard has no docs stylesheet or palette of its own, and no dark mode', () => {
  expect(fs.existsSync(path.join(__dirname, '..', 'web/about.css'))).toBe(false);
  const css = read('web/style.css');
  expect(css).not.toMatch(/^\s*header\b|\.brand|^\s*button|\.button\b|\.ms-signin|--accent:|prefers-color-scheme|^\s*:root/m);
  expect(css).not.toMatch(/about-card|dl-docs-card|\.status\.fixed/);
  expect(css).not.toMatch(/var\(--(bg|card|panel|line|text|muted|accent|accent-soft|danger|ok|radius)\)/);
});

test('the scripts use the shared classes for buttons, tables, cards and tabs', () => {
  const dash = read('web/dash.js');
  expect(dash).toContain("class: 'dl-button bot-check'");
  expect(dash).toContain("class: 'dl-segmented period'");
  expect(dash).toContain("el('table', { class: 'dl-table' })");
  expect(dash).toContain("class: 'dl-table-wrap'");
  expect(dash).toContain('class: `dl-card card');
  expect(dash).not.toMatch(/class: '(link-button|show-more|table-wrap)'/);
  for (const file of DOCS_TABS) {
    expect(read(`web/docs-${file}.js`)).not.toContain("createElement('footer')");
  }
});

test('the sign-in error page uses the shared header and stylesheet', () => {
  const source = read('lambda/dashboard/index.js');
  expect(source).toContain(DL_CSS);
  expect(source).toContain('<body class="dl-page"><header class="dl-header"><a class="dl-brand" href="/"><img class="dl-logo" src="/logo.svg" alt="" width="32" height="32"><span data-zh="DL 流量">DL Traffic</span></a>');
  expect(source).toContain('<script type="module" src="/i18n.js"></script>');
  expect(source).toContain('<p data-message>${escapeHtml(message)}</p>');
  expect(source).toContain('<footer class="dl-footer"><a class="dl-footer-logo" href="https://dliu.com" aria-label="dliu.com">');
});

test('the read-more cards use the shared dl-docs-card classes', () => {
  const diagram = read('web/diagram.js');
  expect(diagram).toContain("el('div', 'dl-docs-cards')");
  expect(diagram).toContain("el('a', 'dl-docs-card')");
  expect(diagram).not.toContain('about-card');
});

test('the app logo is the white bar chart on the DL blue', () => {
  const logo = read('web/logo.svg');
  expect(logo).toContain('<rect width="32" height="32" rx="8" fill="#209cee"/>');
  expect(logo).not.toMatch(/<script|href=/);
});

test.each(ALL_PAGES)('%s links to /docs, not the old About page', (name) => {
  const page = read(`web/${name}.html`);
  expect(page).toContain('<a href="/docs" data-zh="文档">Docs</a> · <a href="https://github.com/dliu-com/traffic-monitor" data-zh="源代码">Source</a></footer>');
  expect(page).not.toMatch(/href="\/(about|detect-bot|cost|security)"/);
});

test('docs.js loads every section and switches tabs by the URL hash', () => {
  const docs = read('web/docs.js');
  for (const tab of DOCS_TABS) {
    expect(docs).toContain(`import './docs-${tab}.js';`);
    expect(read(`web/docs-${tab}.js`)).toContain(`document.getElementById('${tab}')`);
  }
  expect(docs).toContain("window.addEventListener('hashchange'");
});

// i18n.js is an ES module that reads the browser, so the pure helper is pulled out and run on its own here.
const i18nSource = read('web/i18n.js');
const initialLanguage = new Function(`${i18nSource.match(/function initialLanguage[\s\S]*?\n}\n/)[0]}; return initialLanguage;`)();

test('the language follows a saved choice, else the browser (any zh-* is Chinese)', () => {
  expect(initialLanguage('en', 'zh-CN')).toBe('en');
  expect(initialLanguage('zh', 'en-GB')).toBe('zh');
  expect(initialLanguage(null, 'zh-TW')).toBe('zh');
  expect(initialLanguage(null, 'zh')).toBe('zh');
  expect(initialLanguage(null, 'en-US')).toBe('en');
  expect(initialLanguage('fr', 'de-DE')).toBe('en');
  expect(initialLanguage(null, undefined)).toBe('en');
});

test('every page loads i18n.js first and the switcher goes last in the header nav', () => {
  expect(read('web/dash.js')).toMatch(/^(\/\/.*\n)*import '\.\/i18n\.js';/);
  expect(read('web/docs.js')).toMatch(/^import \{ t \} from '\.\/i18n\.js';/);
  for (const name of APP_PAGES) {
    expect(read(`web/${name === 'index' ? 'home' : name}.js`)).toMatch(/from '\.\/dash\.js';/);
  }
  expect(i18nSource).toContain("document.querySelector('.dl-header .dl-nav')");
  expect(i18nSource).toContain('nav.append(box)');
  expect(i18nSource).toContain("box.className = 'dl-language'");
  expect(i18nSource).toContain("toggle.className = 'dl-button dl-language-toggle'");
  expect(i18nSource).toContain("group.id = 'dl-languages'");
  expect(i18nSource).toContain("const KEY = 'traffic-language'");
});

test.each(ALL_PAGES)('%s has Chinese for its fixed text', (name) => {
  const page = read(`web/${name}.html`);
  expect(page).toMatch(/<title data-zh="[^"]+">/);
  expect(page).toContain('data-zh="文档">Docs</a>');
});
