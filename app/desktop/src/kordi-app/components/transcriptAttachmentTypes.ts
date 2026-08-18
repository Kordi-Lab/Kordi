export type AttachmentImageDeliveryVisual = {
  kind: 'uploading' | 'delivering' | 'sent' | 'delivered' | 'read' | 'partial' | 'failed';
  label: string;
};

export type AttachmentImageForegroundTone = 'light' | 'dark';
