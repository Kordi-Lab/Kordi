import { createRoot } from 'react-dom/client';
import { HelpWorkspacePreview } from './helpWorkspacePreview';

document.body.classList.add('theme-light');
createRoot(document.querySelector('#root')!).render(<HelpWorkspacePreview theme="light" />);
