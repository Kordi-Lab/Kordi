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

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const CACHEABLE_CDN_STATUSES = new Set(['hit', 'miss', 'revalidated', 'stale']);
const PUBLIC_CONVERGENCE_ATTEMPTS = 7;
const PUBLIC_CONVERGENCE_DELAY_MS = 2_000;

export async function verifyPublicConvergence(verification, publicHttp) {
  let lastError;
  for (let attempt = 0; attempt < PUBLIC_CONVERGENCE_ATTEMPTS; attempt += 1) {
    try {
      return await verification();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < PUBLIC_CONVERGENCE_ATTEMPTS) {
        await publicHttp.waitForPropagation?.(PUBLIC_CONVERGENCE_DELAY_MS);
      }
    }
  }
  throw lastError;
}

function verifyPublicAssetHeaders(response, {
  contentLength,
  contentType,
  expectedDigest,
  cacheControl,
  contentRange,
  cacheable,
}) {
  if (headerValue(response, 'content-length') !== String(contentLength)) {
    throw new Error('Public response content length does not match the release artifact');
  }
  if (headerValue(response, 'content-type') !== contentType) {
    throw new Error('Public response content type does not match the release artifact');
  }
  if (headerValue(response, 'x-checksum-sha256') !== expectedDigest) {
    throw new Error('Public response checksum header is invalid');
  }
  if (headerValue(response, 'etag') !== `"${expectedDigest}"`) {
    throw new Error('Public response ETag is invalid');
  }
  if (!headerValue(response, 'last-modified')) {
    throw new Error('Public response is missing Last-Modified');
  }
  if (headerValue(response, 'accept-ranges') !== 'bytes') {
    throw new Error('Public response does not advertise byte ranges');
  }
  if (headerValue(response, 'cache-control') !== cacheControl) {
    throw new Error('Public response cache policy is invalid');
  }
  if (contentRange && headerValue(response, 'content-range') !== contentRange) {
    throw new Error('Public range response Content-Range is invalid');
  }
  const cdnStatus = headerValue(response, 'x-kordi-cdn-cache');
  let invalidCdnStatus = !cdnStatus || cdnStatus === 'disabled';
  if (cacheable === true) invalidCdnStatus = !CACHEABLE_CDN_STATUSES.has(cdnStatus);
  if (cacheable === false) invalidCdnStatus = cdnStatus !== 'uncacheable';
  if (invalidCdnStatus) {
    throw new Error('Public response did not traverse the expected CDN cache policy');
  }
}

async function verifyPublicAsset(
  publicHttp,
  url,
  expectedBytes,
  expectedDigest,
  contentType,
  { cacheControl = IMMUTABLE_CACHE_CONTROL, cacheable = true } = {},
) {
  const head = await publicHttp.head(url);
  if (head?.status !== 200) {
    throw new Error(`Public HEAD verification failed with status ${head?.status ?? 'unknown'}`);
  }
  verifyPublicAssetHeaders(head, {
    contentLength: expectedBytes.length,
    contentType,
    expectedDigest,
    cacheControl,
    cacheable: null,
  });

  const rangeEnd = Math.min(expectedBytes.length - 1, 64 * 1024 - 1);
  const range = await publicHttp.get(url, { range: `bytes=0-${rangeEnd}` });
  if (range?.status !== 206) {
    throw new Error(`Public range verification failed with status ${range?.status ?? 'unknown'}`);
  }
  verifyPublicAssetHeaders(range, {
    contentLength: rangeEnd + 1,
    contentType,
    expectedDigest,
    cacheControl,
    contentRange: `bytes 0-${rangeEnd}/${expectedBytes.length}`,
    cacheable,
  });
  if (!responseBody(range).equals(expectedBytes.subarray(0, rangeEnd + 1))) {
    throw new Error('Public range bytes do not match the release artifact');
  }

  const get = await publicHttp.get(url);
  if (get?.status !== 200) {
    throw new Error(`Public GET verification failed with status ${get?.status ?? 'unknown'}`);
  }
  const bytes = responseBody(get);
  if (bytes.length !== expectedBytes.length || sha256(bytes) !== expectedDigest) {
    throw new Error('Public GET length or digest does not match the release artifact');
  }
  verifyPublicAssetHeaders(get, {
    contentLength: expectedBytes.length,
    contentType,
    expectedDigest,
    cacheControl,
    cacheable,
  });
}

export async function verifyPublicReleaseArtifacts(prepared, publicHttp) {
  await verifyPublicAsset(
    publicHttp,
    prepared.urls.manual,
    prepared.artifacts.manual.bytes,
    prepared.artifacts.manual.sha256,
    prepared.release.manual.contentType,
  );
  await verifyPublicAsset(
    publicHttp,
    prepared.urls.updaterArchive,
    prepared.artifacts.updater.bytes,
    prepared.artifacts.updater.sha256,
    prepared.release.platforms['darwin-aarch64'].contentType,
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
    prepared.release.platforms['darwin-aarch64'].contentType,
  );
  if (prepared.channel === 'beta') {
    await verifyPublicAsset(
      publicHttp,
      prepared.urls.stableManual,
      prepared.artifacts.manual.bytes,
      prepared.artifacts.manual.sha256,
      prepared.release.manual.contentType,
      { cacheControl: 'no-store', cacheable: false },
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
