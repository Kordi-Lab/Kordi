import './styles.css';

import { siteContent } from './content.js';
import { renderSite } from './renderSite.js';

const root = document.querySelector('#root');

if (!root) {
  throw new Error('Kordi website root element was not found.');
}

root.innerHTML = renderSite(siteContent);
