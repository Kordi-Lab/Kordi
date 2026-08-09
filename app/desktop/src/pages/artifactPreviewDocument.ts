export type ArtifactPreviewMode = 'panel' | 'rail' | 'window';

const RAIL_PREVIEW_ATTRIBUTE = 'data-kordi-artifact-preview="rail"';

const RAIL_PREVIEW_HEAD = `<meta name="viewport" content="width=device-width, initial-scale=1">
<style data-kordi-artifact-rail-fit>
  html[${RAIL_PREVIEW_ATTRIBUTE}][${RAIL_PREVIEW_ATTRIBUTE}],
  html[${RAIL_PREVIEW_ATTRIBUTE}][${RAIL_PREVIEW_ATTRIBUTE}] body {
    inline-size: 100% !important;
    max-inline-size: 100% !important;
    min-inline-size: 0 !important;
    overflow-x: hidden !important;
  }

  html[${RAIL_PREVIEW_ATTRIBUTE}][${RAIL_PREVIEW_ATTRIBUTE}] body *,
  html[${RAIL_PREVIEW_ATTRIBUTE}][${RAIL_PREVIEW_ATTRIBUTE}] body *::before,
  html[${RAIL_PREVIEW_ATTRIBUTE}][${RAIL_PREVIEW_ATTRIBUTE}] body *::after {
    box-sizing: border-box;
    max-inline-size: 100% !important;
    min-inline-size: 0 !important;
    overflow-wrap: anywhere;
  }

  html[${RAIL_PREVIEW_ATTRIBUTE}][${RAIL_PREVIEW_ATTRIBUTE}] :is(img, video, canvas, svg, iframe) {
    block-size: auto;
    max-inline-size: 100% !important;
  }

  html[${RAIL_PREVIEW_ATTRIBUTE}][${RAIL_PREVIEW_ATTRIBUTE}] table {
    inline-size: 100% !important;
    table-layout: fixed;
  }

  html[${RAIL_PREVIEW_ATTRIBUTE}][${RAIL_PREVIEW_ATTRIBUTE}] :is(pre, code) {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
</style>`;

export function artifactPreviewDocumentSource(source: string, mode: ArtifactPreviewMode) {
  if (mode !== 'rail') return source;

  const htmlOpeningTag = /<html(?:\s[^>]*)?>/i;
  if (!htmlOpeningTag.test(source)) {
    return `<!doctype html><html ${RAIL_PREVIEW_ATTRIBUTE}><head>${RAIL_PREVIEW_HEAD}</head><body>${source}</body></html>`;
  }

  const attributedSource = source.replace(htmlOpeningTag, (tag) => tag.replace(/^<html/i, `<html ${RAIL_PREVIEW_ATTRIBUTE}`));
  if (/<\/head>/i.test(attributedSource)) {
    return attributedSource.replace(/<\/head>/i, `${RAIL_PREVIEW_HEAD}</head>`);
  }

  return attributedSource.replace(htmlOpeningTag, (tag) => `${tag}<head>${RAIL_PREVIEW_HEAD}</head>`);
}
