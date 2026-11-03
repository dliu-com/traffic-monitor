import './docs-architecture.js';
import './docs-bot-detection.js';
import './docs-cost.js';
import './docs-security.js';

const TITLES = { architecture: 'Architecture', 'bot-detection': 'Bot detection', cost: 'Running costs', security: 'Security' };
const TABS = Object.keys(TITLES);

function show(scroll) {
  const hash = location.hash.slice(1);
  const current = TABS.includes(hash) ? hash : TABS[0];
  for (const id of TABS) document.getElementById(id).hidden = id !== current;
  for (const link of document.querySelectorAll('.dl-tabs a')) {
    if (link.dataset.tab === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${TITLES[current]} · Docs · Traffic · dliu.com`;
  if (scroll) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => show(true));
show(false);
