// /docs/health is static HTML built by scripts/health-docs.js. This adds the diagram icons and shows the
// technical details in the reader's language (English without JavaScript).
import { language } from './i18n.js';
import { icon } from './diagram.js';

for (const node of document.querySelectorAll('.dg-step[data-icon]')) node.prepend(icon(node.dataset.icon));
for (const node of document.querySelectorAll('[data-lang]')) node.hidden = node.dataset.lang !== language;
