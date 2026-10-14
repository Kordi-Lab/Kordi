import '../styles/document-blocks.css';
import '../styles/document-collab.css';
import './iosDocumentEditor.css';

import { createEditorPage } from './editorPage';
import { webkitPost } from './nativeBridge';

/** Entry of the iPhone app's document editor page (bundled into the app, never served). */
const post = webkitPost();
const container = document.getElementById('editor');
if (post && container) {
  const { page, receiver } = createEditorPage(post, container);
  Object.assign(window, { kordiEditor: page, kordiNative: receiver });
  post({ type: 'ready' });
}
