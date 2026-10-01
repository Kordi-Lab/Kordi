import { ProjectImportDialog } from '../../src/features/projects/ProjectImportDialog';
import type { ProjectImportApi } from '../../src/features/projects/projectImportApi';

export type ImportedProject = { name: string; root: string; source: 'local' | 'github'; repository?: string };
const api: ProjectImportApi = {
  chooseFolder: async () => '/preview/research-notes',
  repositories: async () => ({ hasMore: false, repositories: [
    { fullName: 'demo-workspace/kordi', description: 'Desktop agent workspace', language: 'TypeScript', private: false },
    { fullName: 'demo-workspace/personal-site', description: 'Portfolio and writing', language: 'Astro', private: false },
    { fullName: 'demo-workspace/design-system', description: 'Shared interface components', language: 'TypeScript', private: true },
  ] }),
  addLocal: async (root) => ({ root, name: root.split('/').pop()! }),
  clone: async (repository, parent) => ({ root: `${parent || '/preview'}/${repository.split('/').pop()}`, name: repository.split('/').pop()! }),
};
export function ProjectImportPreview({ onClose, onImport }: { onClose: () => void; onImport: (project: ImportedProject) => void }) {
  return <ProjectImportDialog preview api={api} onClose={onClose} onImported={async (project) => onImport({ ...project, source: 'local' })} />;
}
