export type CloudSessionForkSummary = {
  forkSessionId: string;
  parentSessionId: string;
  parentMessageId?: string | null;
  createdByAccountId: string;
  createdAt: string;
};

export type CloudTaskActivity = {
  taskActivityId: string;
  sessionId: string;
  taskId: string;
  title: string;
  summary: string | null;
  status: string;
  createdByAccountId: string;
  targetAccountId: string | null;
  participants: unknown[];
  artifactIds: string[];
  responseMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type CloudArtifactActivity = {
  artifactActivityId: string;
  sessionId: string;
  artifactId: string;
  name: string;
  path: string;
  kind: string;
  category: string;
  summary: string | null;
  createdByAccountId: string;
  sourceMessageId: string | null;
  attachmentId: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type CloudSessionActivity = {
  tasks: CloudTaskActivity[];
  artifacts: CloudArtifactActivity[];
};

export type CloudSessionTitle = {
  sessionId: string;
  title: string;
  titleSource: 'placeholder' | 'auto' | 'imported' | 'external' | 'legacy' | 'manual';
  titleRevision: number;
  titlePolicyVersion: number;
  titleGeneratedFromMessageId: string | null;
  updatedAtMs: number;
  updatedByAccountId: string;
  updatedAt: string;
};

export type UpdateCloudSessionTitleInput = Pick<
  CloudSessionTitle,
  'title' | 'titleSource' | 'titleRevision' | 'titlePolicyVersion' | 'titleGeneratedFromMessageId' | 'updatedAtMs'
>;

export type UpsertCloudTaskActivityInput = Omit<CloudTaskActivity, 'taskActivityId' | 'createdAt' | 'updatedAt' | 'archivedAt'> & {
  participantAccountIds: string[];
  clientUpdatedAt?: string | null;
};

export type UpsertCloudArtifactActivityInput = Omit<CloudArtifactActivity, 'artifactActivityId' | 'createdAt' | 'updatedAt' | 'archivedAt'> & {
  participantAccountIds: string[];
  clientUpdatedAt?: string | null;
};
