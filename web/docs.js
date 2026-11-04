import { t } from './i18n.js';
import './docs-architecture.js';
import './docs-bot-detection.js';
import './docs-cost.js';
import './docs-security.js';
import './docs-health.js';

const TITLES = {
  architecture: t('架构', 'Architecture'),
  'bot-detection': t('机器人识别', 'Bot detection'),
  cost: t('成本', 'Cost'),
  security: t('安全', 'Security'),
  health: t('健康', 'Health'),
};
const TABS = Object.keys(TITLES);

function show(scroll) {
  const hash = location.hash.slice(1);
  const current = TABS.includes(hash) ? hash : TABS[0];
  for (const id of TABS) document.getElementById(id).hidden = id !== current;
  for (const link of document.querySelectorAll('.dl-tabs a')) {
    if (link.dataset.tab === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${TITLES[current]} · ${t('文档 · 流量', 'Docs · Traffic')} · dliu.com`;
  if (scroll) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => show(true));
show(false);
