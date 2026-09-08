// Stable releases and the existing beta/corrective-beta versions share one contract.
const NUMBER = String.raw`(?:0|[1-9]\d*)`;
const VERSION = String.raw`${NUMBER}\.${NUMBER}\.${NUMBER}(?:-beta\.${NUMBER}(?:\.${NUMBER})?)?`;

export const VERSION_PATTERN = new RegExp(`^${VERSION}$`);
export const MANIFEST_KEY_PATTERN = new RegExp(
  String.raw`^desktop/releases/${VERSION}/release\.json$`,
);
