import type { Editor } from '@tiptap/core';

import {
  activeBlockStyle,
  activeFormats,
  insertBlock,
  setBlockStyle,
  setLink,
  toggleFormat,
  toggleList,
  type BlockStyle,
  type InlineFormat,
} from '@/features/documents/editor/documentEditorCommands';

const FORMATS: readonly InlineFormat[] = ['bold', 'italic', 'underline', 'strike', 'code', 'highlight'];
const STYLES: readonly BlockStyle[] = ['text', 'h1', 'h2', 'h3', 'quote'];

/** What the app's toolbar shows as on. */
export type ToolbarState = {
  formats: InlineFormat[];
  block: BlockStyle;
  list: boolean;
  orderedList: boolean;
  checklist: boolean;
  link: boolean;
  linkHref: string | null;
};

export function toolbarState(editor: Editor): ToolbarState {
  const href: unknown = editor.getAttributes('link').href;
  return {
    formats: activeFormats(editor),
    block: activeBlockStyle(editor),
    list: editor.isActive('bulletList'),
    orderedList: editor.isActive('orderedList'),
    checklist: editor.isActive('taskList'),
    link: editor.isActive('link'),
    linkHref: typeof href === 'string' ? href : null,
  };
}

/**
 * Runs a toolbar command from the app with the same commands as the Mac's
 * selection menu. Answers false for unknown commands.
 */
export function runEditorCommand(editor: Editor, name: string, value?: string): boolean {
  if ((FORMATS as readonly string[]).includes(name)) return toggleFormat(editor, name as InlineFormat);
  if (name === 'block' && value && (STYLES as readonly string[]).includes(value)) return setBlockStyle(editor, value as BlockStyle);
  switch (name) {
    case 'list': return toggleList(editor);
    case 'orderedList': return editor.chain().focus().toggleOrderedList().run();
    case 'checklist': return editor.isActive('taskList')
      ? editor.chain().focus().toggleTaskList().run()
      : insertBlock(editor, 'checklist');
    case 'link': return setLink(editor, value ?? '');
    case 'codeBlock': return insertBlock(editor, 'code');
    case 'table': return insertBlock(editor, 'table');
    case 'indent': return editor.chain().focus().sinkListItem(editor.isActive('taskList') ? 'taskItem' : 'listItem').run();
    case 'outdent': return editor.chain().focus().liftListItem(editor.isActive('taskList') ? 'taskItem' : 'listItem').run();
    case 'undo': return editor.chain().focus().undo().run();
    case 'redo': return editor.chain().focus().redo().run();
    case 'blur': editor.commands.blur(); return true;
    default: return false;
  }
}
