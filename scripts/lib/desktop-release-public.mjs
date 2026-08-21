import { createHash } from 'node:crypto';

export const PRODUCT_ORIGIN = 'https://kordi.ai';

export function releaseUrlsForOrigin({
  origin,
  version,
  manualName,
  updaterName,
  updaterEndpointPath,
}) {
  return {
    manual: `${origin}/updates/releases/${version}/${manualName}`,
    updaterArchive: `${origin}/updates/releases/${version}/${updaterName}`,
    updaterEndpoint: `${origin}${updaterEndpointPath}`,
    stableManual: `${origin}/updates/releases/latest/Kordi.dmg`,
  };
}

function headerValue(response, name) {
  if (response?.headers?.get) return response.headers.get(name);
  const entries = Object.entries(response?.headers ?? {});
  return entries.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
}

function responseBody(response) {
  if (Buffer.isBuffer(response?.body)) return response.body;
  if (response?.body instanceof Uint8Array) return Buffer.from(response.body);
  if (typeof response?.body === 'string') return Buffer.from(response.body);
  throw new Error('Public response body is unavailable');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function verifyPublicAsset(publicHttp, url, expectedBytes, expectedDigest) {
  const head = await publicHttp.head(url);
  if (head?.status !== 200) {
    throw new Error(`Public HEAD verification failed with status ${head?.status ?? 'unknown'}`);
  }
  if (headerValue(head, 'content-length') !== String(expectedBytes.length)) {
    throw new Error('Public HEAD content length does not match the release artifact');
  }
  if (headerValue(head, 'x-checksum-sha256') !== expectedDigest) {
    throw new Error('Public HEAD digest does not match the release artifact');
  }

  const get = await publicHttp.get(url);
  if (get?.status !== 200) {
    throw new Error(`Public GET verification failed with status ${get?.status ?? 'unknown'}`);
  }
  const bytes = responseBody(get);
  if (bytes.length !== expectedBytes.length || sha256(bytes) !== expectedDigest) {
    throw new Error('Public GET length or digest does not match the release artifact');
  }
  if (headerValue(get, 'x-checksum-sha256') !== expectedDigest) {
    throw new Error('Public GET checksum header is invalid');
  }
}

export async function verifyPublicReleaseArtifacts(prepared, publicHttp) {
  await verifyPublicAsset(
    publicHttp,
    prepared.urls.manual,
    prepared.artifacts.manual.bytes,
    prepared.artifacts.manual.sha256,
  );
  await verifyPublicAsset(
    publicHttp,
    prepared.urls.updaterArchive,
    prepared.artifacts.updater.bytes,
    prepared.artifacts.updater.sha256,
  );
}

export async function verifyPromotedRelease(prepared, publicHttp) {
  const response = await publicHttp.get(prepared.urls.updaterEndpoint);
  if (response?.status !== 200) {
    throw new Error(
      `Updater endpoint post-promotion verification failed with status ${response?.status ?? 'unknown'}`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(responseBody(response).toString('utf8'));
  } catch {
    throw new Error('Updater endpoint returned invalid JSON after promotion');
  }
  const updaterAsset = prepared.release.platforms['darwin-aarch64'];
  if (
    manifest.version !== prepared.version
    || manifest.notes !== prepared.release.notes
    || manifest.pub_date !== prepared.pubDate
    || manifest.url !== prepared.urls.updaterArchive
    || manifest.signature !== updaterAsset.signature
  ) {
    throw new Error('Updater endpoint returned unexpected release metadata after promotion');
  }
  await verifyPublicAsset(
    publicHttp,
    prepared.urls.updaterArchive,
    prepared.artifacts.updater.bytes,
    prepared.artifacts.updater.sha256,
  );
  if (prepared.channel === 'beta') {
    await verifyPublicAsset(
      publicHttp,
      prepared.urls.stableManual,
      prepared.artifacts.manual.bytes,
      prepared.artifacts.manual.sha256,
    );
  }
}

export async function verifyUnpublishedChannel(
  channel,
  publicHttp,
  isValidVersion,
) {
  const endpoint = channel === 'acceptance'
    ? `${PRODUCT_ORIGIN}/updates/desktop/acceptance/darwin/aarch64/0.0.0`
    : `${PRODUCT_ORIGIN}/updates/desktop/darwin/aarch64/0.0.0`;
  const response = await publicHttp.get(endpoint);
  if (response?.status !== 204) {
    throw new Error(
      `Cleared updater endpoint returned status ${response?.status ?? 'unknown'} instead of 204`,
    );
  }
  if (channel === 'beta') {
    const stableUrl = `${PRODUCT_ORIGIN}/updates/releases/latest/Kordi.dmg`;
    const [head, get] = await Promise.all([
      publicHttp.head(stableUrl),
      publicHttp.get(stableUrl),
    ]);
    if (head?.status !== 404 || get?.status !== 404) {
      throw new Error('Cleared beta channel still exposes a stable manual artifact');
    }
    const legacy = await publicHttp.get(`${PRODUCT_ORIGIN}/updates/releases/version`);
    if (legacy?.status !== 200) {
      throw new Error(
        `Legacy fallback returned status ${legacy?.status ?? 'unknown'} instead of 200`,
      );
    }
    let legacyMetadata;
    try {
      legacyMetadata = JSON.parse(responseBody(legacy).toString('utf8'));
    } catch {
      throw new Error('Legacy fallback returned invalid JSON');
    }
    if (
      !isValidVersion(legacyMetadata.version)
      || Object.hasOwn(legacyMetadata, 'downloadUrl')
      || Object.hasOwn(legacyMetadata, 'signature')
    ) {
      throw new Error('Legacy fallback could authorize the unsafe beta.5 native installer');
    }
  }
}
