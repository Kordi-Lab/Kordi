declare module 'pdfmake/build/pdfmake' {
  type PdfMakeApi = {
    vfs?: Record<string, string>;
    createPdf: (docDefinition: unknown) => {
      getBlob: (cb: (blob: Blob) => void, errorCb?: (err: unknown) => void) => void;
    };
  };
  const pdfMake: PdfMakeApi;
  export default pdfMake;
}

declare module 'pdfmake/build/vfs_fonts' {
  const vfs: Record<string, string> | { vfs: Record<string, string> } | { pdfMake: { vfs: Record<string, string> } };
  export default vfs;
}
