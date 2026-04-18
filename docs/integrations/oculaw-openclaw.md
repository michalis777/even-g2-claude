# OcuClaw + OpenClaw — Secure Deployment Design

Initial design doc for running an OpenClaw brain that the Even G2 glasses reach via the OcuClaw plugin. Grounded in research, not a committed plan — revise as we actually deploy.

## What these things are

- **OpenClaw** — self-hosted multi-model AI agent platform (formerly Clawdbot / Moltbot). TypeScript, Node 22+ (24 recommended). Supports 23+ LLM providers, MCP is first-class, local SQLite+`sqlite-vec` for long-term memory. Canonical repo: [`openclaw/openclaw`](https://github.com/openclaw/openclaw). Default gateway WebSocket on port `18789`.
- **OcuClaw** — npm package [`ocuclaw@1.2.4`](https://registry.npmjs.org/ocuclaw), maintained by `ocuclaw` / `mattyford@protonmail.com`. **Server-side OpenClaw plugin, not a standalone service.** No public source repo — distributed as ESM in the npm tarball.
- **OcuClaw phone app** — closed-source app installed from the Even Hub App Store on the paired phone. Handles BLE to the glasses and speech-to-text via Soniox, then talks to the OcuClaw relay.

## Architecture

```
┌───────────────┐     BLE      ┌──────────────────┐   ws://  ┌──────────────────┐  ws://   ┌────────────────────┐
│ Even G2       │◄────────────►│ Even Hub +       │◄─────────┤ OcuClaw relay    │◄─────────┤ OpenClaw gateway   │
│ (stock fw)    │              │ OcuClaw app      │ :9000    │ (in-proc plugin) │ :18789   │ (openclaw daemon)  │
└───────────────┘              │ (phone, Soniox)  │ downstream└──────────────────┘ upstream └────────────────────┘
                               └──────────────────┘                                            │
                                                                                               ▼
                                                                                    MCP servers (gcal, gmail,
                                                                                    GHE, Neon, Vercel, iCal,…)
```

- **Audio never leaves the phone.** Soniox STT runs phone-side using temporary keys minted by the relay. OpenClaw only sees final text (plus optional image attachments, if the phone sends them).
- OcuClaw runs **in-process** inside the OpenClaw daemon. It starts a downstream WebSocket server (default `127.0.0.1:9000`, configurable via `wsBind`/`wsPort`) and an upstream RPC client to the OpenClaw gateway (default `ws://127.0.0.1:18789`).
- OcuClaw throws on startup if `gateway.auth.token` is missing — it cannot run without OpenClaw.

## Auth planes

Two independent auth layers, very different strength levels:

| Plane | Transport | Mechanism | Strength |
|---|---|---|---|
| Phone app ↔ OcuClaw relay (downstream) | `ws://` (no TLS built in) | Shared string `relayToken` | **Weak** — single shared password, no rotation, no per-device identity. Loopback-bind by default; anything beyond that **must** be tunneled. |
| OcuClaw relay ↔ OpenClaw gateway (upstream) | `ws://` loopback | Ed25519 keypair generated at first start; persisted device token at `stateDir/ocuclaw-device-token.json` (mode `0600`). Signed handshake payload `v2\|deviceId\|clientId\|clientMode\|role\|scopes\|signedAtMs\|token\|nonce`. | Strong if `stateDir` ACLs hold. |
| Optional Even-AI HTTP endpoint (`/v1/chat/completions`) | HTTP(S), 64 KiB body cap | Bearer equality against `evenAiToken` | Medium. Off by default. **Do not bind to `0.0.0.0` with this enabled** — turns OpenClaw into an open OpenAI-compatible proxy. |

The downstream weakness is the design's sharpest edge: the glasses path depends entirely on tunneling and firewalling, not on OcuClaw's own transport.

## Recommended deployment pattern

Matches this repo's existing Tailscale + session-token pattern (`README.md` → Security Model):

1. **Small VPS** — 2 vCPU / 4 GB RAM / 20 GB disk is a safe starting point for a single user with memory enabled. Documented minimums were not found in OpenClaw's public docs; scale up if you enable local embeddings. Hetzner/Fly/DO all work.
2. **Run [`openclaw/openclaw-ansible`](https://github.com/openclaw/openclaw-ansible)** — vendor-maintained playbook that installs Docker, joins Tailscale, and closes UFW to everything except `tailscale0`. Credential-isolation work is already done there; don't reinvent it.
3. **Bind the OpenClaw gateway to the tailnet IP only** (`100.x.y.z:18789`), never `0.0.0.0`.
4. **Bind the OcuClaw downstream relay to `127.0.0.1:9000`** (default) and front it with a `wss://` reverse proxy on the same host, or tunnel it over Tailscale to the phone.
5. **Reuse this repo's session-token pattern** as a second factor in front of OcuClaw's `relayToken` — mint a UUID session token after a token+tailnet handshake, TTL 30 days, ban-IP-after-3-fails, same mechanism as `relay-server/server.js`.
6. **Pin OpenClaw to a post-2026.2.25 release** (see CVE notes below) and subscribe to GitHub Security Advisories for the repo.

Rejected alternatives, briefly:

- **Public TLS via Caddy/nginx** — unnecessary attack surface given the Control-UI CVE history (CVE-2026-25253 was exactly that path).
- **Cloudflare Tunnel + Access** — adds a third-party trust boundary for no benefit over Tailscale, which we already operate.
- **Pure on-prem home server** — fine functionally, worse when away from home without a relay back in.

## Threat model (first cut)

| Asset | Threat | Mitigation |
|---|---|---|
| `relayToken` (downstream shared password) | Phone compromise, MITM on LAN, leak via screenshot | Never expose port 9000 publicly; Tailscale-only; rotate when phone is lost. Treat like the G2 master token. |
| `stateDir/ocuclaw-device-*.json` (Ed25519 key + device token) | Host compromise → operator-level OpenClaw access | `0600`, encrypted root FS, VPS disk-at-rest encryption; back up encrypted. |
| OpenClaw config `~/.openclaw/openclaw.json` (LLM API keys, Soniox key, `evenAiToken`) | Plaintext at rest — no built-in encryption found in docs reachable from research | Mode `0600`; consider `sops`/`systemd-creds`; tmpfs for secrets in Docker. |
| Memory store `~/.openclaw/workspace` (SQLite + embeddings) | Off-box leak = full content + embeddings exposure | Encrypted volume; never snapshot unencrypted. |
| Soniox API key | Baked into phone = fleet compromise if leaked | Keep server-side; rely on relay's short-lived temporary-key minting (already the default code path). |
| `/v1/chat/completions` Even-AI endpoint | Open OpenAI-compatible proxy if misbound | Leave `evenAiEnabled:false` unless needed; if enabled, bind loopback and require rotating `evenAiToken`. |
| Gmail / Calendar / GHE read access through OpenClaw MCP | Prompt injection via inbound email or PR description → data exfil | Metadata-only scopes where possible; never pair Gmail-read with arbitrary-send tools in the same session. See [`mcp-targets.md`](./mcp-targets.md). |
| `externalDebugToolsEnabled` config flag | Unlocks `debug-set` / `debug-dump` / remote control on the downstream socket | Keep `false` outside a dev loop. |

## Known CVEs / security posture

OpenClaw has a non-trivial CVE stream. Pin to current releases and track the advisory feed.

- **CVE-2026-25253** (CVSS 8.8, patched 2026.1.29) — Control UI trusted a `gatewayURL` query parameter, leaking the auth token over a WebSocket to attacker-controlled hosts. One-click RCE on the daemon host. [Writeup](https://www.proarch.com/blog/threats-vulnerabilities/openclaw-rce-vulnerability-cve-2026-25253).
- **CVE-2026-32922** (CVSS 9.9, disclosed 2026-03-29) — separate privilege escalation. [Writeup](https://www.armosec.io/blog/cve-2026-32922-openclaw-privilege-escalation-cloud-security/).
- Community advisory tracker [`jgamblin/OpenClawCVEs`](https://github.com/jgamblin/OpenClawCVEs) claims 156 advisories total — likely inflated by SEO content, but the real count is high enough to treat OpenClaw as a "patch-weekly" system.

Minimum operating requirement: running a release **≥ 2026.2.25**.

## Known limitations / gotchas

- **No public OcuClaw source repo** — we're reverse-engineering from the npm tarball. No issue tracker; protocol compatibility with future Even firmware updates is undocumented.
- **`relayToken` has no rotation story** — treat it as a device password and rebuild when a phone is lost.
- **Soniox is the only wired STT** — no Deepgram/Whisper/local fallback in the plugin code.
- **`sessionLimit: 10` concurrent downstream clients** by default — fine for personal use, sizing constraint to remember.
- **Thinking-summary polling** runs `chat.history` every 500 ms during an active run — cheap locally, noisy if the upstream socket is tunneled over a high-latency link.
- **Closed-source phone app** — if Even ships a breaking update, OcuClaw must follow; we have no source-level workaround.

## Open questions (to resolve before first deploy)

- [ ] Which VPS / region? (Prefer same region as the phone for latency.)
- [ ] Do we add our session-token layer as a separate reverse-proxy process in front of the OcuClaw relay, or fork the relay? (Research default: proxy — less coupling to unversioned OcuClaw internals.)
- [ ] Memory-store backup cadence + encryption pattern — `restic` to an S3-compatible bucket seems default-reasonable.
- [ ] Which LLM provider for OpenClaw's primary model — Claude Sonnet 4.6 is the likely default for this repo's taste.
- [ ] Is `evenAiEnabled` worth turning on? (Only if we want the Even-AI native mic path to hit our OpenClaw instead of Even's cloud.)

## References

- OpenClaw repo: https://github.com/openclaw/openclaw
- Ansible hardening: https://github.com/openclaw/openclaw-ansible
- OcuClaw npm: https://registry.npmjs.org/ocuclaw (tarball: https://registry.npmjs.org/ocuclaw/-/ocuclaw-1.2.4.tgz)
- G1 reference implementation: https://github.com/littlebotshi/openclaw-glasses
- ClawMem (memory-as-MCP bridge): https://github.com/yoloshii/ClawMem
- CVE tracker: https://github.com/jgamblin/OpenClawCVEs
