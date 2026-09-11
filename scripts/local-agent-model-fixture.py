#!/usr/bin/env python3
"""Loopback-only model fixture for the opt-in native local-tools smoke test.

Uses the real native harness and real tools, with deterministic model responses.
Does not log prompts, file contents, credentials, or application inventories.
"""
import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ModelFixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        payload = json.dumps({"object": "list", "data": [
            {"id": "local-access-fixture", "object": "model", "owned_by": "local"}
        ]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2_000_000:
            self.send_error(413)
            return
        body = json.loads(self.rfile.read(length))
        messages = body.get("messages", [])
        context = "\n".join(str(message.get("content", "")) for message in messages)
        match = re.search(r"<local_execution_context>\n([^\n]+)", context)
        environment = json.loads(match.group(1)) if match else {}
        results = {message.get("tool_call_id"): str(message.get("content", ""))
                   for message in messages if message.get("role") == "tool"}
        calls = [
            ("qa-read", "read", {"path": "~/kordi-local-tools-qa-fixture/marker.txt"}),
            ("qa-shell", "bash", {"command": "cat marker.txt", "raw": True}),
            ("qa-app", "local_app", {"action": "script", "bundle_id": "com.apple.finder",
                                     "script": "return {running: app.running()};"}),
        ]
        remaining = [call for call in calls if call[0] not in results]
        if remaining:
            call_id, name, arguments = remaining[0]
            delta = {"role": "assistant", "tool_calls": [{
                "index": 0, "id": call_id, "type": "function",
                "function": {"name": name, "arguments": json.dumps(arguments)},
            }]}
            reason = "tool_calls"
        else:
            verified = (
                str(environment.get("workingDirectory", "")).endswith("/kordi-local-tools-qa-fixture")
                and environment.get("executionPolicy") == "yolo"
                and "KORDI_LOCAL_ACCESS_VERIFIED" in results.get("qa-read", "")
                and "KORDI_LOCAL_ACCESS_VERIFIED" in results.get("qa-shell", "")
                and '"running":true' in results.get("qa-app", "")
            )
            status = "PASS" if verified else "FAILED"
            delta = {"role": "assistant", "content": f"LOCAL_ACCESS_SMOKE {status}"}
            reason = "stop"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        events = [
            {"id": "qa", "object": "chat.completion.chunk", "choices": [
                {"index": 0, "delta": delta, "finish_reason": None}
            ]},
            {"id": "qa", "object": "chat.completion.chunk", "choices": [
                {"index": 0, "delta": {}, "finish_reason": reason}
            ], "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}},
        ]
        for event in events:
            self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), ModelFixture).serve_forever()
