export type CloudMessageAttachment = {
  attachmentId: string;
  previewAttachmentId?: string | null;
  name: string;
  kind: 'image' | 'file';
  subtype?: 'meme' | null;
  altText?: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  downloadUrl?: string | null;
  previewUrl?: string | null;
  localPath?: string | null;
};

export type SendCloudMessageAttachmentInput = {
  attachmentId: string;
  name: string;
  kind: 'image' | 'file';
  subtype?: 'meme' | null;
  altText?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  previewUrl?: string | null;
};

export type CloudVoiceMessage = {
  mediaId: string;
  mimeType: string;
  durationMs: number;
  waveformSamples: number[];
  transcript: string;
  localPath?: string | null;
};

export type SendCloudVoiceMessageInput = Omit<CloudVoiceMessage, 'mediaId'>;

export type CloudAttachmentInitiateResult = {
  attachmentId: string;
  objectKey: string;
  uploadUrl: string;
  expiresAt: string;
};

export type CloudAttachmentFinalizeResult = {
  attachmentId: string;
  objectKey: string;
  sizeBytes: number | null;
  contentType: string | null;
  sha256Hex: string | null;
  finalizedAt: string | null;
};

export type CloudAttachmentDownloadUrlResult = {
  attachmentId: string;
  downloadUrl: string;
  expiresAt: string;
};

export type CloudAttachmentPreviewUpdateResult = {
  attachmentId: string;
  previewUrl: string;
  updatedLinks: number;
};

export type CloudExpressiveMediaItem = {
  itemId: string;
  attachmentId: string;
  kind: 'sticker' | 'gif';
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type CloudExpressiveMediaListResponse = {
  items: CloudExpressiveMediaItem[];
};

export type CloudExpressiveMediaMutationResponse = {
  item: CloudExpressiveMediaItem;
};
