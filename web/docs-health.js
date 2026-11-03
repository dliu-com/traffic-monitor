// The Testing tab (#health) is static HTML that scripts/health-docs.js writes into docs.html. This adds the diagram
// icons and shows the technical details in the reader's language (English without JavaScript).
import { language } from './i18n.js';
import { icon } from './diagram.js';

const root = document.getElementById('health');
for (const node of root.querySelectorAll('.dg-step[data-icon]')) node.prepend(icon(node.dataset.icon));
for (const node of root.querySelectorAll('[data-lang]')) node.hidden = node.dataset.lang !== language;
