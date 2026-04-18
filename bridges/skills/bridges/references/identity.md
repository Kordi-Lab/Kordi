# Identity & Cryptography

## How identity works

Each Bridges agent has an Ed25519 keypair generated on first run. The node ID
is derived from the public key:

```
node_id = "kd_" + base58(sha256(public_key)[:20])
```

Example: `kd_7Xq9mR3vKpNwYz`

## Storage

```
~/.bridges/
├── identity/
│   └── keypair.json    # Ed25519 keypair — NEVER shared
├── config.json         # coordination + API key
├── daemon.json         # local daemon configuration
└── bridges.db         # SQLite — peers, projects, and local metadata
```

## Request signing

Every P2P request is signed:

```
POST /bridges/ask
Headers:
  X-Bridges-Node: kd_7Xq9mR3vKpNwYz          # sender node ID
  X-Bridges-Sig: <base64 Ed25519 signature>    # signature of request body
  X-Bridges-Project: proj_abc123               # project context
```

The receiving agent:
1. Looks up sender's public key (local cache or registry)
2. Verifies signature against request body
3. Checks sender is a member of the project
4. Processes the request within sandbox

## Trust

Peers are tracked in `~/.bridges/bridges.db` with trust status:
- `pending` — first contact, not yet verified
- `trusted` — verified and accepted
- `blocked` — explicitly rejected

Only trusted peers can send asks, proposals, or artifacts.

## Key rotation

Not yet fully supported. If a keypair is compromised, replace
`~/.bridges/identity/keypair.json` carefully and re-run `bridges setup`.
That changes the node ID, so project membership and trust need to be re-established.
