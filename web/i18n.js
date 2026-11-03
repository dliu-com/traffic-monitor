// Chinese or English, as on blog.dliu.com: a choice saved in this browser wins; otherwise the browser's language
// decides (any zh-* is Chinese, everything else English). Choosing the other language saves it and reloads the page,
// so every script draws its text once, with t(zh, en).
// Static HTML: data-zh holds the Chinese text, data-zh-label the Chinese aria-label, and data-message marks a message
// from the server (the sign-in error page) to translate with translateError.
const KEY = 'traffic-language';
const LANGUAGES = [['zh', '中文'], ['en', 'English']];

export function initialLanguage(saved, browserLanguage) {
  if (saved === 'zh' || saved === 'en') return saved;
  return /^zh(?:-|$)/i.test(browserLanguage || '') ? 'zh' : 'en';
}

// ?lang=zh|en is only used when the browser blocks storage, so the switcher still works.
const fromUrl = new URLSearchParams(location.search).get('lang');
export const language = initialLanguage(fromUrl || readSaved(), navigator.language);
export const t = (zh, en) => (language === 'zh' ? zh : en);
// For Intl formatters (numbers, dates, country names).
export const locale = language === 'zh' ? 'zh-CN' : 'en-GB';

// Messages the API and sign-in send, in Chinese. Anything unknown is shown as sent.
const ERRORS = {
  'Not found': '未找到',
  'Internal error': '服务器内部错误',
  'Sign-in expired or invalid. Please try again.': '登录已过期或无效，请重试。',
  'Sign-in failed during token exchange.': '登录失败：令牌交换出错。',
  'Something went wrong while signing in.': '登录时出错了。',
  'Sign-in is not configured yet. Run "make set-secrets".': '尚未配置登录，请运行 "make set-secrets"。',
};
const PATTERNS = [
  [/^Sign-in failed: (.+)$/, (code) => `登录失败：${code}`],
  [/^(.+) is not allowed to view this dashboard\.$/, (who) => `${who === 'This account' ? '此账号' : who} 无权查看此仪表板。`],
  [/^Request failed \((\d+)\)$/, (n) => `请求失败（${n}）`],
];
export function translateError(message) {
  if (language !== 'zh' || !message) return message;
  if (ERRORS[message]) return ERRORS[message];
  for (const [pattern, zh] of PATTERNS) {
    const match = pattern.exec(message);
    if (match) return zh(...match.slice(1));
  }
  return message;
}

function translatePage() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  if (language !== 'zh') return;
  for (const node of document.querySelectorAll('[data-zh]')) node.textContent = node.dataset.zh;
  for (const node of document.querySelectorAll('[data-zh-label]')) node.setAttribute('aria-label', node.dataset.zhLabel);
  for (const node of document.querySelectorAll('[data-message]')) node.textContent = translateError(node.textContent);
}

// The shared dl-language switcher (dl.css), last in the header's dl-nav (inside the ☰ menu on the dashboard pages):
// 中文 | English buttons; on narrow screens a 文/A button opens them.
function mountSwitcher() {
  const nav = document.querySelector('.dl-header .dl-nav');
  if (!nav || nav.querySelector('.dl-language')) return;
  const box = document.createElement('div');
  box.className = 'dl-language';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'dl-button dl-language-toggle';
  toggle.textContent = '文/A';
  toggle.setAttribute('aria-controls', 'dl-languages');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Language / 语言');
  const group = document.createElement('div');
  group.id = 'dl-languages';
  group.className = 'dl-languages';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Language / 语言');
  const setOpen = (open) => {
    group.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  for (const [value, label] of LANGUAGES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.language = value;
    button.lang = value === 'zh' ? 'zh-CN' : 'en';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(value === language));
    button.addEventListener('click', () => {
      setOpen(false);
      if (value === language) return;
      try { localStorage.setItem(KEY, value); } catch { /* storage blocked */ }
      const url = new URL(location.href);
      if (readSaved() === value) url.searchParams.delete('lang');
      else url.searchParams.set('lang', value);
      if (url.href === location.href) location.reload();
      else location.replace(url.href);
    });
    group.append(button);
  }
  toggle.addEventListener('click', () => setOpen(!group.classList.contains('is-open')));
  document.addEventListener('click', (event) => { if (!box.contains(event.target)) setOpen(false); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && group.classList.contains('is-open')) { setOpen(false); toggle.focus(); }
  });
  box.append(toggle, group);
  nav.append(box);
}

function readSaved() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

translatePage();
mountSwitcher();
