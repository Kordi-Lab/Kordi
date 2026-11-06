#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_JS_CHUNK_BYTES = Number.parseInt(process.env.KORDI_MAX_JS_CHUNK_BYTES ?? '', 10) || 700_000;
// The pinned OMP catalog grew with 18.12.6 (80 providers), so the budget moved from 5.4 MB to 5.5 MB.
// Main reached 5.495 MB, and proactive runs on the owner's Mac add 7 kB, so it moves to 5.6 MB.
// Direct read receipts add 1 kB, durable Mac agent communication adds 5 kB,
// and persistent exchange progress with ordered-output filtering adds 2 kB.
// Parallel text attachment previews and explicit external opening add less than 1 kB.
// Actual-size gestures, panning, and original-image clipboard copying add 3.9 kB.
// Ops-owned login copy and admission guidance add a separate bounded 1 kB.
// Inline tool previews and disclosure scroll anchoring receive a bounded 2 kB allowance,
// including the community API configuration used by production browser tests.
// Allow another 1 kB for memory import result counts and interrupted-save reconciliation.
// Calendar read-only consent, provider permissions, and setup readiness add less than 1 kB.
// Factory account selection and owner-leased smoke tests add up to 3 kB.
// Full forwarded snapshots, bounded rich rendering, voice cleanup, and document format feedback add 4 kB.
// Compact shell materials, corner geometry, and sidebar cover motion add less than 5 kB.
// Searchable document tabs, native snap scrolling, and source wrapping add 14 kB.
// Shared Chat, Digest, and Calendar tabs add 3 kB.
// The aligned chat navigation and session menu add less than 2 kB.
// Browser sign-in (welcome and wait screens, PKCE flow, token refresh) adds 22 kB.
// The compact frosted sign-in window and the cut-out bird add 3 kB.
// The launch release (organization selection and request headers, account security, browser
// sign-in recovery and the split desktop features chunk) adds 19 kB, so it moves to 5.72 MB.
// Pending group invitations on the account and their join prompt add 2 kB.
// Shared browser runtime selection (cookie transport, browser session and adapter routing,
// hosted navigation and delivery scopes) adds 17 kB, so it moves to 5.745 MB.
// Agent avatars beside agent messages, the Mac app card, first-paint plan cards and
// remembered transcript row heights add 3 kB, so it moves to 5.748 MB.
// AI consent (the consent and AI-off dialogs, the send gates, Settings › Privacy) adds 8 kB.
// Blocking and abuse reports (block and report dialogs, the blocked list, the safety client) add 14 kB.
// Collapsing blocked accounts' group messages and silencing their message alerts add 2 kB.
// Per-person permissions (the contact pane switches and their client) add 2 kB.
// Applying them on the Mac (the restricted list, context filtering, the member popover switches) adds 2 kB.
// Blocking and per-person permissions together in the same contact and member views add 2 kB.
// Real group avatars in the Groups in common row add 2 kB.
// Removing deleted and blocked contacts at once and Unblock on profiles add 2 kB.
// The tidied empty Memory tab and the site sign-in hand-off add 2 kB.
// The dense menu shared by Help and Start a chat moves 1.3 kB of styles out of the on-demand
// help chunk and adds the popover's focus handling, 3 kB in all.
// The dense Start group picker and its Invite with a link step add 4 kB.
// Handing a Mac run without hosted credentials back to the cloud and reconciling a
// requester's ended runs add 3 kB, so it moves to 5.794 MB.
// Group names before creating, dissolving groups and channels, the Link copied toast and
// the group created line add 9 kB, so it moves to 5.803 MB.
// Resuming background sessions on their saved provider route and owner-sent replies add 6 kB.
// The redesigned group Info panel and its Manage level add 3.5 kB.
// Default agent access controls in the Factory add 1 kB.
// Per-account rate limit wait times in sign-in and link errors add under 1 kB.
// The discussion panel, artifacts tab alignment, border contrast and thread read state add 1.5 kB.
// The dense popover help styles remove 5.5 kB, so it moves to 5.809 MB.
// Folding long groups of background session rows adds 2.9 kB.
// Running reply Stop on the status line with Fork on hover removes 1 kB, so it moves to 5.811 MB.
// Remembered turn and tool disclosure state and the folded tool activity rows add 2.8 kB.
// Memory import from chosen files (the browser picker, its limits and the server
// extraction call) and Import in the Memory tab add 3.4 kB.
// The community-profile build used by the browser tests is 0.6 kB larger, so it moves to 5.818 MB.
// The separate Agent Chats entry and page for the personal agent add 7.4 kB.
// Slower idle polling, the base64 cache and self-agent reconcile backoff add 0.7 kB, so it moves to 5.826 MB.
// Refreshing Grounding Recent and the narrow-pane wallet layout add 0.7 kB.
// Keeping a read session's explicit zero unread count adds 0.5 kB, so it moves to 5.827 MB.
const MAX_DESKTOP_DIST_BYTES = Number.parseInt(process.env.KORDI_MAX_DESKTOP_DIST_BYTES ?? '', 10) || 5_827_000;
// The separate browser target adds cookie transport, IndexedDB projections and
// URL navigation. Its bounded allowance does not change desktop packaging.
// AI consent, blocking and per-person permissions add 12 kB to the browser target too.
// Removing deleted and blocked contacts at once and Unblock on profiles add 3 kB there.
// The tidied empty Memory tab adds under 1 kB to the browser target.
// The dense menu and the dense Start group picker add the same 7 kB.
// Reconciling a requester's ended agent runs and the cloud hand-back add 3 kB there too, so it moves to 5.826 MB.
// The second launch fixes batch adds 8.3 kB there, as on the desktop target, before the items below.
// Remembered turn and tool disclosure state and the folded tool activity rows add 2.8 kB there.
// Memory import from chosen files adds 3.4 kB there.
// The cloud-edition build used by the browser tests is 0.7 kB larger, so it moves to 5.831 MB.
// The separate Agent Chats entry and page for the personal agent add 7.4 kB there.
// Idle polling, the base64 cache and idempotent browser canonical writes add 1.5 kB there, so it moves to 5.84 MB.
// Refreshing Grounding Recent and the narrow-pane wallet layout add 0.7 kB there.
// Unread counts from browser chat sync without a badge flash add 2.5 kB there, so it moves to 5.843 MB.
const MAX_WEB_APP_DIST_BYTES = 5_843_000;
// Offline picker artwork replaces hundreds of runtime image requests. Give
// these four known atlases a separate cap without relaxing the app/code budget.
const MAX_NOTO_THUMBNAIL_BYTES = 2_600_000;
// The document editor (Tiptap, ProseMirror, Markdown parser) is one lazy chunk that loads with the
// first opened document. It gets its own cap, like the atlases, without relaxing the app budget.
const MAX_DOCUMENT_EDITOR_BYTES = 750_000;
// Product guides and permission setup load only when Help opens. Bound their
// JavaScript and CSS together, keeping the existing app/startup budget intact.
const MAX_HELP_CENTER_BYTES = 50_000;
// Original legal texts load only in the offline license viewer. Bound them
// separately so compliance material cannot weaken the application budget.
const MAX_LICENSE_BYTES = 16_000_000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const assetsDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'dist', 'assets');
const applicationBudget = process.argv.includes('--web-app')
  ? MAX_WEB_APP_DIST_BYTES : MAX_DESKTOP_DIST_BYTES;

function formatKb(bytes) {
  return `${(bytes / 1_000).toFixed(2)} kB`;
}

async function collectJsChunks(directory) {
  const entries = await readdir(directory);
  const chunks = await Promise.all(entries
    .filter((entry) => entry.endsWith('.js'))
    .map(async (entry) => {
      const filePath = path.join(directory, entry);
      const metadata = await stat(filePath);
      return { name: entry, bytes: metadata.size };
    }));

  return chunks.sort((left, right) => right.bytes - left.bytes);
}

async function directoryBytes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? directoryBytes(filePath) : (await stat(filePath)).size;
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

try {
  const chunks = await collectJsChunks(assetsDir);
  if (chunks.length === 0) {
    console.error(`No built JavaScript chunks found in ${assetsDir}. Run pnpm --dir app/desktop build first.`);
    process.exit(1);
  }

  const oversizedChunks = chunks.filter((chunk) => chunk.bytes > MAX_JS_CHUNK_BYTES);
  if (oversizedChunks.length > 0) {
    console.error(`JavaScript chunk budget exceeded. Maximum allowed chunk size is ${formatKb(MAX_JS_CHUNK_BYTES)}.`);
    for (const chunk of oversizedChunks) {
      console.error(`- ${chunk.name}: ${formatKb(chunk.bytes)}`);
    }
    process.exit(1);
  }

  const licenseDirectory = path.join(path.dirname(assetsDir), 'licenses');
  let licenseBytes = 0;
  try { licenseBytes = await directoryBytes(licenseDirectory); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (licenseBytes > MAX_LICENSE_BYTES) throw new Error('Offline license documents exceed their separate 16 MB budget.');
  const largestChunk = chunks[0];
  const distBytes = await directoryBytes(path.dirname(assetsDir));
  const atlasFiles = (await readdir(assetsDir)).filter(name => /^atlas-[0-3]-[\w-]+\.webp$/.test(name));
  const atlasSizes = await Promise.all(atlasFiles.map(async name => (await stat(path.join(assetsDir, name))).size));
  const atlasBytes = atlasSizes.reduce((total, size) => total + size, 0);
  if (atlasBytes > MAX_NOTO_THUMBNAIL_BYTES || atlasFiles.length > 4) {
    throw new Error('Bundled Noto thumbnails exceed their separate 2.6 MB budget.');
  }
  const editorChunks = chunks.filter((chunk) => /^document-editor-[\w-]+\.js$/.test(chunk.name));
  const editorBytes = editorChunks.reduce((total, chunk) => total + chunk.bytes, 0);
  if (editorBytes > MAX_DOCUMENT_EDITOR_BYTES || editorChunks.length > 1) {
    throw new Error(`The document editor chunk exceeds its separate ${formatKb(MAX_DOCUMENT_EDITOR_BYTES)} budget (${formatKb(editorBytes)}).`);
  }
  const helpFiles = (await readdir(assetsDir)).filter((name) => /^help-center-[\w-]+\.(?:js|css)$/.test(name));
  const helpSizes = await Promise.all(helpFiles.map(async (name) => (await stat(path.join(assetsDir, name))).size));
  const helpBytes = helpSizes.reduce((total, size) => total + size, 0);
  if (helpBytes > MAX_HELP_CENTER_BYTES || helpFiles.filter((name) => name.endsWith('.js')).length > 1 || helpFiles.filter((name) => name.endsWith('.css')).length > 1) {
    throw new Error(`The help center exceeds its separate ${formatKb(MAX_HELP_CENTER_BYTES)} budget (${formatKb(helpBytes)}).`);
  }
  // Rolldown can move shared dependencies into a named lazy group, causing an
  // eager import back into it. Only the dynamically imported help entries may
  // statically import the help chunk; other app chunks must not load it.
  for (const chunk of chunks.filter((item) => !/^(?:HelpMenu|HelpTour)-[\w-]+\.js$/.test(item.name))) {
    const source = await readFile(path.join(assetsDir, chunk.name), 'utf8');
    if (/\b(?:import|export)\s*(?:\{[^}]*\}|\*[^;]*)?\s*(?:from\s*)?["']\.\/(?:help-center|HelpMenu|HelpTour)-[\w-]+\.js["']/.test(source)) {
      throw new Error(`Help must load on demand, but ${chunk.name} imports it eagerly.`);
    }
  }
  if (distBytes - atlasBytes - editorBytes - helpBytes - licenseBytes > applicationBudget) {
    console.error(`Application bundle budget exceeded. Maximum allowed size is ${formatKb(applicationBudget)}.`);
    console.error(`- dist: ${formatKb(distBytes)}`);
    process.exit(1);
  }
  console.log(`JavaScript chunk budget ok: ${chunks.length} chunks, largest ${largestChunk.name} at ${formatKb(largestChunk.bytes)}.`);
  console.log(`Desktop web bundle budget ok: ${formatKb(distBytes)} total.`);
  if (licenseBytes) console.log(`Offline license documents: ${formatKb(licenseBytes)} of ${formatKb(MAX_LICENSE_BYTES)}.`);
  if (atlasBytes) console.log(`Bundled Noto thumbnails: ${formatKb(atlasBytes)} of ${formatKb(MAX_NOTO_THUMBNAIL_BYTES)}.`);
  if (editorBytes) console.log(`Document editor chunk: ${formatKb(editorBytes)} of ${formatKb(MAX_DOCUMENT_EDITOR_BYTES)}.`);
  if (helpBytes) console.log(`Help center: ${formatKb(helpBytes)} of ${formatKb(MAX_HELP_CENTER_BYTES)}.`);
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    console.error(`No built JavaScript chunks found in ${assetsDir}. Run pnpm --dir app/desktop build first.`);
    process.exit(1);
  }
  throw error;
}
