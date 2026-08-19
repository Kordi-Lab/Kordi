import { invokeDesktop } from './desktop';

export type DesktopCloudAttachmentUploadResult = {
  attachmentId: string;
  objectKey: string;
  sizeBytes: number | null;
  contentType: string | null;
  sha256Hex: string | null;
  finalizedAt: string | null;
};

export function uploadDesktopCloudAttachment(
  requestId: string,
  path: string,
  contentType?: string | null,
) {
  return invokeDesktop<DesktopCloudAttachmentUploadResult>('desktop_cloud_attachment_upload', {
    requestId,
    path,
    contentType: contentType ?? null,
  });
}

export function cancelDesktopCloudAttachmentUpload(requestId: string) {
  return invokeDesktop<void>('desktop_cloud_attachment_cancel', { requestId });
}
