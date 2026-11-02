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
const DOCS_PAGES = ['about', 'detect-bot', 'cost', 'security'];
const ALL_PAGES = [...APP_PAGES, ...DOCS_PAGES];

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
  expect(page).toContain(`<a class="dl-brand" href="/"><img class="dl-logo" src="/logo.svg" alt="" width="32" height="32">DL Traffic</a>`);
  expect(page).toMatch(/<nav (id="dl-menu" )?class="dl-nav( dl-nav-collapsible)?" aria-label="Site">/);
  expect(page).toMatch(/<main class="dl-main[" ]/);
  expect(page).toContain(`<footer class="dl-footer"><a class="dl-footer-logo" href="https://dliu.com" aria-label="dliu.com"><img src="${DL_ICON}" alt="" width="24" height="24"></a> <a href="https://dliu.com">dliu.com</a>`);
  expect(page).not.toContain('/about.css');
});

test.each(APP_PAGES)('%s has the ☰ menu just before the nav', (name) => {
  expect(read(`web/${name}.html`)).toContain('<button type="button" class="dl-button dl-menu-toggle" aria-controls="dl-menu" aria-expanded="false" aria-label="Menu">☰</button>\n    <nav id="dl-menu" class="dl-nav dl-nav-collapsible" aria-label="Site">');
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
  expect(page).toContain('<a class="dl-button" href="/auth/logout">Sign out</a>');
  expect(page).toContain('<a id="signin-link" class="dl-button dl-signin" href="/auth/login" hidden>Sign in</a>');
  expect(page).toContain('<a class="dl-ms-signin" href="/auth/login">');
  expect(page).toContain('<section id="signin" hidden class="dl-card signin">');
});

test.each(DOCS_PAGES)('%s uses the shared docs stylesheet and tabs', (name) => {
  const page = read(`web/${name}.html`);
  expect(page.indexOf(DOCS_CSS)).toBeGreaterThan(page.indexOf(DL_CSS));
  expect(page.indexOf(DOCS_CSS)).toBeLessThan(page.indexOf('<link rel="stylesheet" href="/style.css">'));
  expect(page).toContain('<main class="dl-main dl-docs-main">');
  expect(page).toContain('<nav class="dl-tabs" aria-label="Docs sections">');
  expect(page).toMatch(/<article id="[a-z-]+" class="dl-docs">/);
  for (const tab of ['/about', '/detect-bot', '/cost', '/security']) expect(page).toContain(`<a href="${tab}"`);
  expect(page).toContain(`<a href="/${name}" aria-current="page">`);
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
  for (const file of ['about', 'detect-bot', 'cost', 'security']) {
    expect(read(`web/${file}.js`)).not.toContain("createElement('footer')");
  }
});

test('the sign-in error page uses the shared header and stylesheet', () => {
  const source = read('lambda/dashboard/index.js');
  expect(source).toContain(DL_CSS);
  expect(source).toContain('<body class="dl-page"><header class="dl-header"><a class="dl-brand" href="/"><img class="dl-logo" src="/logo.svg" alt="" width="32" height="32">DL Traffic</a>');
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
