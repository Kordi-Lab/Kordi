#!/usr/bin/env node

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  PRODUCT_ORIGIN,
  publishDesktopRelease,
  redactPublisherText,
} from './lib/desktop-release.mjs';

const VALUE_ARGUMENTS = new Map([
  ['--release-dir', 'releaseDir'],
  ['--app-bundle', 'appBundle'],
  ['--version', 'version'],
  ['--channel', 'channel'],
  ['--release-profile', 'releaseProfile'],
  ['--expected-commit', 'expectedCommit'],
  ['--pub-date', 'pubDate'],
]);

export function parsePublisherArguments(argv) {
  const options = { dryRun: false, releaseProfile: 'production' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const property = VALUE_ARGUMENTS.get(argument);
    if (!property) throw new Error(`Unknown publisher argument: ${argument}`);
    const value = argv[index += 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    options[property] = value;
  }
  return options;
}

function requireEnvironment(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required for release publication`);
  }
  return value.trim();
}

async function awsBodyToBuffer(body) {
  if (!body) throw new Error('Release object response body is unavailable');
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function createS3ReleaseStore({ env = process.env, client: injectedClient } = {}) {
  const endpointText = requireEnvironment(env, 'KORDI_RELEASE_S3_ENDPOINT').replace(/\/$/, '');
  let endpoint;
  try {
    endpoint = new URL(endpointText);
  } catch {
    throw new Error('KORDI_RELEASE_S3_ENDPOINT must be a valid HTTP or HTTPS URL');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('KORDI_RELEASE_S3_ENDPOINT must be an HTTP or HTTPS URL without credentials');
  }
  const bucket = (env.KORDI_RELEASE_S3_BUCKET ?? 'kordi-releases').trim();
  if (bucket !== 'kordi-releases') throw new Error('KORDI_RELEASE_S3_BUCKET must be kordi-releases');
  const region = requireEnvironment(env, 'KORDI_RELEASE_S3_REGION');
  const accessKeyId = requireEnvironment(env, 'KORDI_RELEASE_PUBLISHER_ACCESS_KEY');
  const secretAccessKey = requireEnvironment(env, 'KORDI_RELEASE_PUBLISHER_SECRET_KEY');
  const {
    GetObjectCommand,
    PutObjectCommand,
    S3Client,
  } = await import('@aws-sdk/client-s3');
  const client = injectedClient ?? new S3Client({
    endpoint: endpoint.toString().replace(/\/$/, ''),
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    async getObject(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (typeof response.ETag !== 'string' || response.ETag.trim().length === 0) {
          throw new Error('Release object response did not include an ETag');
        }
        return {
          bytes: await awsBodyToBuffer(response.Body),
          etag: response.ETag,
          versionId: response.VersionId ?? null,
        };
      } catch (error) {
        const status = error?.$metadata?.httpStatusCode;
        if (status === 404 || error?.name === 'NoSuchKey' || error?.Code === 'NoSuchKey') return null;
        throw new Error('Unable to read a release object from private storage', { cause: error });
      }
    },
    async putObject(key, bytes, metadata = {}) {
      try {
        if (metadata.ifMatch && metadata.ifNoneMatch) {
          throw new Error('Release object mutation cannot use both If-Match and If-None-Match');
        }
        const response = await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: metadata.contentType,
          CacheControl: metadata.cacheControl,
          ...(metadata.ifMatch ? { IfMatch: metadata.ifMatch } : {}),
          ...((metadata.ifNoneMatch || metadata.immutable) ? { IfNoneMatch: metadata.ifNoneMatch ?? '*' } : {}),
        }));
        return { etag: response.ETag ?? null, versionId: response.VersionId ?? null };
      } catch (error) {
        if (
          (metadata.immutable || metadata.ifMatch || metadata.ifNoneMatch)
          && ([409, 412].includes(error?.$metadata?.httpStatusCode) || error?.name === 'PreconditionFailed')
        ) {
          throw new Error(`Release object changed concurrently at ${key}`, { cause: error });
        }
        throw new Error('Unable to write a release object to private storage', { cause: error });
      }
    },
  };
}

export function createPublicHttpAdapter({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A Fetch implementation is required');
  async function request(url, method, requestHeaders = {}) {
    const parsed = new URL(url);
    if (parsed.origin !== PRODUCT_ORIGIN) {
      throw new Error(`Public verification URL must use ${PRODUCT_ORIGIN}`);
    }
    const response = await fetchImpl(parsed, {
      method,
      redirect: 'error',
      cache: 'no-store',
      headers: {
        Accept: method === 'GET' ? 'application/json, application/octet-stream;q=0.9, */*;q=0.1' : '*/*',
        ...requestHeaders,
      },
    });
    return {
      status: response.status,
      headers: response.headers,
      body: method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer()),
    };
  }
  return {
    head(url) { return request(url, 'HEAD'); },
    get(url, options = {}) {
      return request(url, 'GET', options.range ? { Range: options.range } : {});
    },
  };
}

export async function runPublisherCli(argv = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env ?? process.env;
  try {
    const options = parsePublisherArguments(argv);
    const store = options.dryRun
      ? undefined
      : (dependencies.store ?? await createS3ReleaseStore({ env }));
    const publicHttp = options.dryRun
      ? undefined
      : (dependencies.publicHttp ?? createPublicHttpAdapter());
    const logger = dependencies.logger ?? {
      info(message) {
        console.log(redactPublisherText(message, env));
      },
    };
    const result = await publishDesktopRelease(options, {
      ...(dependencies.verifier ? { verifier: dependencies.verifier } : {}),
      store,
      publicHttp,
      logger,
    });
    const mode = result.dryRun ? 'validated dry-run' : 'published';
    console.log(`[release] ${mode} ${result.version} on ${result.channel}`);
    return 0;
  } catch (error) {
    console.error(`[release] failed: ${redactPublisherText(error?.message ?? error, env)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runPublisherCli();
}
