import type { SessionArtifact } from '@/kordi-app/types';

export function fileNameFromPath(path: string) {
  return path.split('/').filter(Boolean).pop()?.trim() || path;
}


export function extensionLabel(path: string, fallback: SessionArtifact['kind'] = 'file') {
  const extension = fileNameFromPath(path).split('.').pop()?.trim().toLowerCase();
  if (!extension || extension === fileNameFromPath(path).toLowerCase()) return fallback;
  if (extension === 'markdown') return 'md';
  return extension;
}


export function languageFromPath(path: string) {
  const extension = path.split('.').pop()?.trim().toLowerCase();
  if (!extension) return 'text';
  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension)) return 'javascript';
  if (['ts', 'tsx'].includes(extension)) return 'typescript';
  if (['py', 'py3'].includes(extension)) return 'python';
  if (['sh', 'zsh', 'bash'].includes(extension)) return 'bash';
  if (extension === 'rs') return 'rust';
  if (['css', 'scss'].includes(extension)) return 'css';
  if (['html', 'htm', 'svg'].includes(extension)) return 'html';
  if (['yaml', 'yml'].includes(extension)) return 'yaml';
  if (['md', 'mdx'].includes(extension)) return 'markdown';
  if (['mmd', 'mermaid'].includes(extension)) return 'mermaid';
  return extension;
}


export function artifactPreviewKind(path: string) {
  const extension = extensionLabel(path).toLowerCase();
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'svg') return 'svg';
  if (extension === 'md' || extension === 'mdx') return 'markdown';
  if (extension === 'mmd' || extension === 'mermaid') return 'mermaid';
  if (extension === 'json') return 'json';
  if (extension === 'csv' || extension === 'tsv') return 'table';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(extension)) return 'image';
  return 'source';
}
