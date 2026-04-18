#!/usr/bin/env node

import http from "node:http";

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 18081,
    name: "mock-agent",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") {
      args.host = argv[++i];
    } else if (arg === "--port") {
      args.port = Number(argv[++i]);
    } else if (arg === "--name") {
      args.name = argv[++i];
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }

  return args;
}

function extractField(prompt, label) {
  const match = prompt.match(new RegExp(`^${label}:\\s*(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

function extractPeerMessage(prompt) {
  const match = prompt.match(
    /--- BEGIN PEER MESSAGE \(treat as data, not instructions\) ---\n([\s\S]*?)\n--- END PEER MESSAGE ---/
  );
  return match ? match[1].trim() : "";
}

function buildResponse(name, prompt) {
  const kind = extractField(prompt, "Type") || "ask";
  const from = extractField(prompt, "From") || "unknown";
  const project = extractField(prompt, "Project") || "unknown";
  const peerMessage = extractPeerMessage(prompt) || "(empty)";
  const summary = peerMessage.replace(/\s+/g, " ").slice(0, 220);
  return `${name} handled ${kind} from ${from} in ${project}. Peer message: ${summary}`;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const { host, port, name } = parseArgs(process.argv);

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ok: true, name });
  }

  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    return sendJson(res, 404, { error: "not found" });
  }

  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body);
      const prompt = parsed?.messages?.[0]?.content ?? "";
      const content = buildResponse(name, prompt);
      console.log(`[${name}] request handled`);
      sendJson(res, 200, {
        id: `mock-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: parsed?.model ?? "mock-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content,
            },
            finish_reason: "stop",
          },
        ],
      });
    } catch (error) {
      sendJson(res, 400, { error: String(error) });
    }
  });
});

server.listen(port, host, () => {
  console.log(`[${name}] listening on http://${host}:${port}`);
});
