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
