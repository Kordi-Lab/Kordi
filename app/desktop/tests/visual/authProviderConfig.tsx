import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthPreview } from '../../src/dev/AuthPreview';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('kordi.themeMode.v1', params.get('theme') === 'dark' ? 'dark' : 'light');
const requested = params.get('variant');
const variant = requested === 'start' || requested === 'login' ? requested : 'settings';
createRoot(document.getElementById('root')!).render(<StrictMode><AuthPreview variant={variant} /></StrictMode>);
