import { useEffect, useId, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Folder, FolderOpen, GitBranch, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { AppDialog } from '@/components/ui/dialog';
import { desktopProjectImportApi, githubRepositoryFromInput, type GithubRepository, type ProjectImportApi } from './projectImportApi';

export function ProjectImportDialog({ onClose, onImported, api = desktopProjectImportApi, preview = false }: {
  onClose: () => void;
  onImported: (project: { root: string; name: string }) => Promise<void>;
  api?: ProjectImportApi;
  preview?: boolean;
}) {
  const id = useId();
  const [source, setSource] = useState<'local' | 'github' | null>(null);
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState('');
  const [folder, setFolder] = useState('');
  const [parent, setParent] = useState('');
  const [repositories, setRepositories] = useState<GithubRepository[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<{ root: string; name: string } | null>(null);
  useEffect(() => {
    if (source !== 'github') return;
    let canceled = false;
    void api.repositories(page).then((result) => {
      if (canceled) return;
      setRepositories((current) => [...new Map([...(page > 1 ? current : []), ...result.repositories].map((repo) => [repo.fullName, repo])).values()]);
      setHasMore(result.hasMore);
    }).catch((reason: unknown) => {
      if (!canceled) setLoadError(reason instanceof Error ? reason.message : 'Unable to load GitHub repositories.');
    }).finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [api, page, refresh, source]);

  const chooseFolder = async (destination: boolean) => {
    setBusy(true); setError('');
    try {
      const path = await api.chooseFolder();
      if (path) { if (destination) setParent(path); else setFolder(path); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to choose a folder. Enter its path instead.'); }
    finally { setBusy(false); }
  };
  const repository = githubRepositoryFromInput(query) ?? selection;
  const matches = repositories.filter((repo) => repo.fullName.toLowerCase().includes(query.toLowerCase()));
  const addProject = async () => {
    setBusy(true); setError('');
    try {
      const project = imported ?? (source === 'local' ? await api.addLocal(folder.trim()) : await api.clone(repository, parent.trim() || undefined));
      setImported(project);
      await onImported(project);
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to add the project.'); }
    finally { setBusy(false); }
  };
  const locked = busy || Boolean(imported);
  return <AppDialog titleId={`${id}-title`} descriptionId={`${id}-description`} onDismiss={onClose} dismissDisabled={busy} busy={busy} className="chat-project-import">
    <header className="chat-project-import-heading">
      {source ? <button type="button" aria-label="Back to project sources" disabled={locked} onClick={() => { setSource(null); setSelection(''); setQuery(''); setError(''); }}><ArrowLeft size={16} /></button> : <Folder size={18} />}
      <h2 id={`${id}-title`}>{source === 'github' ? 'Add from GitHub' : source === 'local' ? 'Add a local project' : 'Add project'}</h2>
      <button type="button" aria-label="Close project import" disabled={busy} onClick={onClose}><X size={16} /></button>
    </header>
    <p id={`${id}-description`}>{source === 'github' ? 'Choose a repository or paste its GitHub URL.' : source === 'local' ? 'Choose the folder where your agent will work.' : 'Keep your files and agent sessions together.'}</p>
    {!source ? <div className="chat-project-sources">
      <button type="button" onClick={() => setSource('local')}><FolderOpen size={21} /><span><strong>Local folder</strong><small>Use a project already on your computer</small></span><ChevronRight size={16} /></button>
      <button type="button" onClick={() => { setLoading(true); setLoadError(''); setSource('github'); }}><GitBranch size={21} /><span><strong>GitHub repository</strong><small>Choose a repository and a local workspace</small></span><ChevronRight size={16} /></button>
    </div> : <>
      {source === 'local' ? <>
        <button type="button" className="chat-project-folder-browse" disabled={locked} onClick={() => void chooseFolder(false)}><FolderOpen size={17} />Choose folder…</button>
        <label className="chat-project-path-label">Folder path<input autoFocus value={folder} disabled={locked} onChange={(event) => setFolder(event.target.value)} placeholder="Choose a folder or enter its path" /></label>
      </> : <>
        <div className="chat-project-repo-search"><Search size={15} /><input autoFocus disabled={locked} aria-label="Search repositories or paste a GitHub URL" placeholder="Search repositories or paste a GitHub URL" value={query} onChange={(event) => { setQuery(event.target.value); setSelection(''); }} /></div>
        <div className="chat-project-subheading"><span>{githubRepositoryFromInput(query) ? 'Repository from URL' : preview ? 'Demo repositories' : 'Your GitHub repositories'}</span><button type="button" disabled={loading || locked} aria-label="Refresh repositories" onClick={() => { setLoading(true); setLoadError(''); setPage(1); setRefresh((current) => current + 1); }}><RefreshCw size={13} /></button></div>
        {loadError ? <p role="status" className="chat-project-load-error">{loadError}</p> : null}
        <div className="chat-project-source-list">
          {githubRepositoryFromInput(query) ? <button type="button" disabled={locked} aria-pressed="true"><GitBranch size={16} /><span>{repository}</span><Check size={16} /></button> : matches.map((repo) =>
            <button type="button" key={repo.fullName} disabled={locked} aria-pressed={selection === repo.fullName} onClick={() => setSelection(repo.fullName)}><GitBranch size={17} /><span><strong>{repo.fullName}</strong><small>{[repo.description, repo.language, repo.private ? 'Private' : null].filter(Boolean).join(' · ')}</small></span>{selection === repo.fullName ? <Check size={16} /> : null}</button>,
          )}
          {loading ? <p className="chat-project-empty" role="status">Loading repositories…</p> : !githubRepositoryFromInput(query) && !matches.length && !loadError ? <p className="chat-project-empty">{query ? 'No matching repositories. Paste a GitHub repository URL.' : 'No repositories found. Paste a GitHub repository URL.'}</p> : null}
          {hasMore && !githubRepositoryFromInput(query) ? <button type="button" disabled={loading || locked} onClick={() => { setLoading(true); setLoadError(''); setPage((current) => current + 1); }}>Load more repositories</button> : null}
        </div>
        {repository ? <div className="chat-project-destination"><Folder size={15} /><span>Local workspace <strong>{parent || 'KordiProjects'}/{repository.split('/').pop()}</strong></span><button type="button" disabled={locked} onClick={() => void chooseFolder(true)}>Change</button></div> : null}
      </>}
      <button type="button" className="chat-project-primary" disabled={busy || (!imported && !(source === 'local' ? folder.trim() : repository))} onClick={() => void addProject()}>{busy ? <><LoaderCircle size={14} className="animate-spin" />{source === 'github' && !imported ? 'Cloning repository…' : 'Adding project…'}</> : imported ? 'Retry opening project' : 'Add project'}</button>
    </>}
    {error ? <p role="alert" className="chat-project-import-error">{error}</p> : null}
    {preview ? <p className="chat-project-disclaimer">Design preview · Imports use demo data. No files are read and no repositories are cloned.</p> : null}
  </AppDialog>;
}
