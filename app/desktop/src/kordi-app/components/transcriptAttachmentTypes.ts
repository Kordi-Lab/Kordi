export type AttachmentImageDeliveryVisual = {
  kind: 'uploading' | 'delivering' | 'sent' | 'delivered' | 'partial' | 'failed';
  label: string;
};

export type AttachmentImageForegroundTone = 'light' | 'dark';
