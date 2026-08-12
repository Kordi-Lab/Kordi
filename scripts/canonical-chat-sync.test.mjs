import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import test from "node:test";

async function readTree(relativeDirectory, extensions) {
  const directory = new URL(`../${relativeDirectory}/`, import.meta.url);
  const chunks = [];

  async function visit(url) {
    const entries = await readdir(url, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = new URL(entry.name, url);
      if (entry.isDirectory()) {
        await visit(new URL(`${entry.name}/`, url));
      } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        chunks.push(await readFile(child, "utf8"));
      }
    }
  }

  await visit(directory);
  return chunks.join("\n");
}

async function readFiles(relativePaths) {
  return Promise.all(relativePaths.map((relativePath) => (
    readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
  )));
}

test("canonical chat has no runtime rollout switch or retired chat route", async () => {
  const [server, deployment, desktop, desktopNative, ios, contract] = await Promise.all([
    readTree("bridges/cloud-server/src", [".rs"]),
    readTree("bridges/cloud-server/deploy", [".md", ".yaml", ".yml", ".sh"]),
    readTree("app/desktop/src", [".ts", ".tsx"]),
    readTree("app/desktop/src-tauri/src", [".rs"]),
    readTree("app/ios/Kordi", [".swift"]),
    readTree("shared/chat-sync", [".md", ".json", ".yaml", ".yml"]),
  ]);
  const active = [server, deployment, desktop, desktopNative, ios, contract].join("\n");

  assert.doesNotMatch(active, /KORDI_CHAT_SYNC_V2_ENABLED|CHAT_SYNC_V2_DISABLED/);
  assert.doesNotMatch(active, /ChatSyncV2|CloudChatV2|ChatV2|chatSyncV2|chat_sync_v2::/);
  for (const route of [
    "/v1/cloud/messages",
    "/v1/cloud/messages/read",
    "/v1/cloud/sync",
    "/v1/cloud/sessions/:source_session_id/read",
    "/v1/cloud/sessions/:source_session_id/title",
  ]) {
    assert.equal(active.includes(route), false, `retired chat route returned: ${route}`);
  }

  assert.match(server, /\/v2\/chat\/sync/);
  assert.match(desktop, /\/v2\/chat\/sync/);
  assert.match(ios, /\/v2\/chat\/sync/);
  assert.match(contract, /\/v2\/chat\/sync/);
});

test("canonical chat source and contract names are unversioned", async () => {
  for (const retiredPath of [
    "../shared/chat-sync-v2",
    "../docs/cloud-mobile-v2.md",
    "../app/desktop/src/features/cloud/chatSyncV2Client.ts",
    "../app/desktop/src/lib/desktopChatSyncV2.ts",
  ]) {
    await assert.rejects(access(new URL(retiredPath, import.meta.url)));
  }

  const [messageSchema, eventSchema] = await Promise.all([
    readFile(new URL("../shared/chat-sync/schemas/message.schema.json", import.meta.url), "utf8"),
    readFile(new URL("../shared/chat-sync/schemas/event-envelope.schema.json", import.meta.url), "utf8"),
  ]);
  assert.match(messageSchema, /https:\/\/kordi\.ai\/schemas\/chat-sync\/message\.schema\.json/);
  assert.match(eventSchema, /https:\/\/kordi\.ai\/schemas\/chat-sync\/event-envelope\.schema\.json/);
  assert.doesNotMatch(`${messageSchema}\n${eventSchema}`, /chat-sync-v2/);
});

test("remaining versioned chat names are migration inputs, not live choices", async () => {
  const [desktopSchema, desktopCacheMigration, selfAgentIdentity, selfAgentForwardSync, deploy] = await readFiles([
    "app/desktop/src-tauri/src/canonical_sessions/schema.rs",
    "app/desktop/src/features/cloud/indexedDbCloudMessageCacheStore.ts",
    "app/desktop/src/features/cloud/cloudSelfAgentIdentity.ts",
    "app/desktop/src/features/cloud/cloudSelfAgentForwardSync.ts",
    "bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh",
  ]);
  const compatibility = [
    desktopSchema,
    desktopCacheMigration,
    selfAgentIdentity,
    selfAgentForwardSync,
    deploy,
  ].join("\n");

  assert.match(desktopSchema, /migrate_versioned_chat_tables/);
  assert.match(desktopSchema, /DROP TABLE \{previous\}/);
  assert.match(desktopCacheMigration, /migratePreviousDatabase/);
  assert.match(desktopCacheMigration, /deleteDatabase\(PREVIOUS_CLOUD_MESSAGES_INDEXED_DB_NAME\)/);
  assert.match(selfAgentIdentity, /removeItem\(`\$\{PREVIOUS_RECOVERY_KEY_PREFIX\}/);
  assert.match(selfAgentForwardSync, /removeItem\(\s*`\$\{PREVIOUS_CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX\}/);
  assert.match(deploy, /get secret kordi-chat-sync-v2/);
  assert.match(deploy, /create secret generic kordi-chat-sync/);

  assert.doesNotMatch(compatibility, /enabled.*v2|v2.*enabled/i);
});

test("historical plans direct readers to the canonical chat contract", async () => {
  const notice = await readFile(
    new URL("../docs/superpowers/README.md", import.meta.url),
    "utf8",
  );
  assert.match(notice, /not the current product architecture/);
  assert.match(notice, /\.\.\/cloud-mobile\.md/);
  assert.match(notice, /\.\.\/\.\.\/shared\/chat-sync\/README\.md/);
  assert.match(notice, /Do not restore a historical route or storage model/);
});
