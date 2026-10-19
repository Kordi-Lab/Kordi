"""Connect GitHub with GitHub's device flow, so the tester signs in on
github.com instead of typing a username.

The app shows a short code and opens github.com/login/device; the tester
enters the code and approves. The server polls GitHub in the background and,
once approved, keeps only the account name. The token asks for no scopes
(public data only), stays in memory, and is dropped right after the lookup.

Needs a GitHub OAuth app with Device Flow enabled; its client id comes from
KORDI_GITHUB_CLIENT_ID.
"""
from __future__ import annotations

import os
import threading
import time

import httpx

DEVICE_URL = "https://github.com/login/device/code"
TOKEN_URL = "https://github.com/login/oauth/access_token"
GRANT = "urn:ietf:params:oauth:grant-type:device_code"


class GitHubDevice:
    def __init__(self, on_login):
        self.client_id = os.environ.get("KORDI_GITHUB_CLIENT_ID", "")
        self.on_login = on_login
        self.lock = threading.Lock()
        self.state = {"status": "idle"}
        self.attempt = 0

    def start(self) -> dict:
        if not self.client_id:
            raise RuntimeError("GitHub sign-in is not set up on this server.")
        r = httpx.post(DEVICE_URL, data={"client_id": self.client_id, "scope": ""},
                       headers={"Accept": "application/json"}, timeout=15)
        body = r.json()
        if "error" in body:
            if body["error"] == "device_flow_disabled":
                raise RuntimeError("Turn on Device Flow in the GitHub app settings.")
            raise RuntimeError(body.get("error_description") or body["error"])
        with self.lock:
            self.attempt += 1
            attempt = self.attempt
            self.state = {"status": "pending", "user_code": body["user_code"],
                          "verification_uri": body["verification_uri"], "expires_in": body["expires_in"]}
        threading.Thread(target=self._poll, args=(attempt, body["device_code"], body["interval"], body["expires_in"]),
                         daemon=True).start()
        return self.view()

    def view(self) -> dict:
        with self.lock:
            return dict(self.state)

    def cancel(self):
        with self.lock:
            self.attempt += 1
            self.state = {"status": "idle"}

    def _set(self, attempt: int, state: dict) -> bool:
        with self.lock:
            if attempt != self.attempt:
                return False
            self.state = state
            return True

    def _poll(self, attempt: int, device_code: str, interval: int, expires_in: int):
        deadline = time.time() + expires_in
        while time.time() < deadline:
            time.sleep(interval)
            if attempt != self.attempt:
                return
            try:
                body = httpx.post(TOKEN_URL, data={"client_id": self.client_id, "device_code": device_code, "grant_type": GRANT},
                                  headers={"Accept": "application/json"}, timeout=15).json()
            except httpx.HTTPError:
                continue
            error = body.get("error")
            if error == "authorization_pending":
                continue
            if error == "slow_down":
                interval = body.get("interval", interval + 5)
                continue
            if error:
                self._set(attempt, {"status": "denied" if error == "access_denied" else "expired"})
                return
            try:
                user = httpx.get("https://api.github.com/user", timeout=15, headers={
                    "Authorization": f"Bearer {body['access_token']}", "Accept": "application/vnd.github+json"}).json()
            except httpx.HTTPError:
                self._set(attempt, {"status": "expired"})
                return
            login = user.get("login")
            if login and self._set(attempt, {"status": "done", "login": login}):
                self.on_login(login)
            return
        self._set(attempt, {"status": "expired"})
