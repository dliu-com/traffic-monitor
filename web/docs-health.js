// The Testing tab (#health) is static HTML that scripts/health-docs.js writes into docs.html; this adds the icons to
// its steps and big numbers.
import { icon } from './diagram.js';

const root = document.getElementById('health');
for (const node of root.querySelectorAll('[data-icon]')) node.prepend(icon(node.dataset.icon));
