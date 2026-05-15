export type ScratchKind = 'canvas' | 'doc';

export type ScratchMetadata = {
  id: string;
  kind: ScratchKind;
  name: string;
  createdAt: number;
  updatedAt: number;
};
