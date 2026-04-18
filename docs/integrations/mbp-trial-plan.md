# MBP Trial Plan — OpenClaw on 2019 Intel MacBook Pro

Deployment plan for running OpenClaw on the existing 2019 Intel MBP (32 GB RAM, always-on, office). Zero hardware spend. Covers pre-flight, install, hardening, integrations, and the OcuClaw handoff once the glasses arrive.

**Stack at a glance:**
- OpenClaw daemon bound to Tailscale IP only
- Router model: Gemini 2.5 Flash-Lite (cloud, ~$1-2/month)
- Reasoner: Claude Sonnet 4.6 via `Enderfga/openclaw-claude-code` wrapper → Max subscription (no API billing)
- Fallback: Gemini 2.5 Flash
- No local inference — Intel CPU makes it non-viable; all savings come from Max-backed Sonnet

---

## 0. Mosyle profile audit — what we know about this host

Based on `sudo profiles show -all` run 2026-04-18 (32 profiles, org `Digital Artefacts LLC`). This is the binding constraint set for everything below.

### Nothing blocks the core plan

| Concern | Profile | Status |
|---|---|---|
| URL / content filter | none | ✅ Outbound to `api.anthropic.com`, `generativelanguage.googleapis.com`, `mcp.neon.tech`, `mcp.vercel.com`, `api.github.com` is free |
| VPN enforcement | none | ✅ Tailscale can run |
| DNS override | none | ✅ |
| Kernel / system extensions | #7, #25, #31 | ✅ Tailscale uses Network Extension, not kext — should pass |
| Application firewall | #26 (enforced ON) + #32 (logging ON) | ✅ Already where we want it — **skip Phase 3's firewall steps** |

### Three hard constraints that reshape the plan

1. **Mosyle has Full Disk Access via TCC** (profiles #10, #14, #15, #22, #30 — `com.apple.TCC.configuration-profile-policy`). The Mosyle agent can read every file on disk, including `~/.openclaw/workspace` (memory DB), `~/.openclaw/openclaw.json` (secrets), and anything else we store. **This is the single biggest risk** — it makes the memory DB effectively visible to the employer.
2. **Two corporate CA roots trusted system-wide** (profiles #16 `da-root.pem`, #19 `DA Root CA`). Alone not interception; on the `dart_secure` corp wifi, enables it. Do all OAuth flows off-corp-wifi.
3. **FileVault recovery key escrowed to Mosyle** (#8 payload[4]). FileVault protects from a stolen laptop, not from the employer.

### Two things to test before committing to Phase 2

- **LaunchAgent install** — profile #11 `com.apple.servicemanagement` controls background services. `openclaw onboard --install-daemon` creates a LaunchAgent; might silently fail. Install a dummy plist first to verify.
- **Tailscale system extension approval** — profile #31. The approval UI may require admin confirmation that could be blocked.

---

## 1. Plan

### Phase 0 — Pre-flight (half day)

Three explicit gates. If any fail, stop and re-plan before proceeding.

**Gate A — Tailscale system extension installs and connects**

```bash
brew install --cask tailscale
open -a Tailscale
# A system extension approval dialog should appear. If it does NOT appear
# and Tailscale fails to start, Mosyle profile #31 is blocking — stop here.
tailscale up
tailscale status   # should show tailnet IP 100.x.y.z
tailscale ping <your-phone>
```

**Gate B — LaunchAgent install works (dummy test)**

Before trusting `openclaw onboard --install-daemon`, verify that Mosyle's background-service-management profile (#11) doesn't silently block user LaunchAgents:

```bash
# Create a trivial test LaunchAgent
cat > ~/Library/LaunchAgents/com.test.hello.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.test.hello</string>
  <key>ProgramArguments</key><array><string>/bin/echo</string><string>hello</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.test.hello.plist
launchctl list | grep com.test.hello   # must return a line
launchctl unload ~/Library/LaunchAgents/com.test.hello.plist
rm ~/Library/LaunchAgents/com.test.hello.plist
```

If `launchctl list` returns nothing, OpenClaw's auto-start daemon won't install either — fall back to running `openclaw gateway` manually in a `tmux` or `screen` session (acceptable, just less convenient).

**Gate C — Rest of the environment checks**

```bash
id                                       # confirm admin group
sudo -v                                  # confirm sudo works (MDM prompt OK)
sw_vers                                  # macOS 13+ required; Sequoia 15 is fine
node --version                           # need 22+; use nvm if not
curl -s https://api.anthropic.com/v1/messages -o /dev/null -w "%{http_code}\n"
                                         # expect 401 (unauthed but reachable), not 0 or network error
curl -s https://generativelanguage.googleapis.com -o /dev/null -w "%{http_code}\n"
                                         # expect 200/404, not 0
```

If any of A/B/C fails, document what happened and escalate before doing anything irreversible.

---

### Phase 1 — Foundation (half day)

```bash
# Homebrew (skip if already present)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node 22+
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22 && nvm alias default 22

# Git (should already be present)
git --version

# Tailscale — join your personal tailnet
brew install --cask tailscale
# Log in with your personal Tailscale account, NOT any work SSO
tailscale up --accept-routes

# Prevent the MacBook from sleeping when lid is closed or on AC
sudo pmset -a sleep 0
sudo pmset -a disablesleep 1
sudo pmset -a hibernatemode 0
# Also: System Settings → Battery → Prevent automatic sleeping when display is off → ON

# Verify FileVault is on (likely enforced by Mosyle — just confirm)
fdesetup status
```

---

### Phase 2 — OpenClaw install (1 day)

```bash
# Install OpenClaw globally — pin to a release >= 2026.2.25
npm install -g openclaw@latest
openclaw --version   # verify

# Onboard — this creates ~/.openclaw/ and registers a LaunchAgent
openclaw onboard --install-daemon

# Verify the daemon is registered
launchctl list | grep openclaw
```

Edit `~/.openclaw/openclaw.json` after onboarding. Key fields to set:

```jsonc
{
  "gateway": {
    "port": 18789,
    "bind": "TAILSCALE_IP_HERE",   // 100.x.y.z — never 0.0.0.0
    "auth": {
      "token": "<generate: openssl rand -hex 32>"
    }
  },
  "memory": {
    "enabled": true,
    "workspacePath": "~/.openclaw/workspace"
  },
  "agent": {
    "model": "google/gemini-2.5-flash-lite",  // default router
    "fallbackModel": "google/gemini-2.5-flash"
  },
  "providers": {
    "google": {
      "apiKey": "<GEMINI_API_KEY_FROM_KEYCHAIN>"
    }
  }
}
```

Do NOT put API keys in plaintext in this file. Use the macOS Keychain:

```bash
# Store Gemini key in Keychain, reference via env in the LaunchAgent plist
security add-generic-password -a openclaw -s GEMINI_API_KEY -w "<your-key>"
# Then in ~/Library/LaunchAgents/com.openclaw.gateway.plist, add:
# <key>EnvironmentVariables</key>
# <dict><key>GEMINI_API_KEY</key><string>$(security find-generic-password -a openclaw -s GEMINI_API_KEY -w)</string></dict>
```

Protect config file:
```bash
chmod 600 ~/.openclaw/openclaw.json
chmod 700 ~/.openclaw/
```

---

### Phase 3 — Harden the surface (half day)

Mosyle already enforces the macOS Application Firewall (profile #26) with logging (#32), so we skip the firewall-on steps. The real hardening here is **defending against Mosyle's own read access** to the memory DB and secrets.

**Memory DB encryption at rest (critical — mitigates Mosyle TCC Full Disk Access):**

Mosyle's TCC profile grants the Mosyle agent Full Disk Access. Anything in plaintext under `~/.openclaw/` is readable by them. The mitigation is to store the memory DB on an **encrypted sparseimage** whose passphrase lives only in your personal password manager:

```bash
# Create a 10 GB encrypted sparseimage, passphrase from personal 1Password/Bitwarden
hdiutil create -size 10g -type SPARSE -fs APFS -encryption AES-256 \
  -volname openclaw-workspace ~/openclaw-workspace.sparseimage

# Mount it (prompts for passphrase)
hdiutil attach ~/openclaw-workspace.sparseimage
# -> mounts at /Volumes/openclaw-workspace

# Point OpenClaw at the mounted volume
# Edit ~/.openclaw/openclaw.json:
#   "memory": { "workspacePath": "/Volumes/openclaw-workspace" }

# Unmount when not in use (e.g., overnight)
hdiutil detach /Volumes/openclaw-workspace
```

Mosyle will see the `.sparseimage` file but cannot decrypt it without your passphrase. The memory DB is readable only when mounted, which is only when OpenClaw is running. Trade-off: you either auto-mount on login (reduces protection — passphrase must live in Keychain, which Mosyle can potentially access) or mount manually each morning.

**Secrets handling:**
- Store all provider API keys via `security add-generic-password ... -s <name>` — Keychain is not airtight against Mosyle but is still better than plaintext config.
- Never put the raw API keys into `~/.openclaw/openclaw.json`. Reference them via environment variables injected from Keychain at daemon-start time.
- The OpenClaw device token at `stateDir/ocuclaw-device-token.json` — keep this *inside* the encrypted sparseimage too if the plugin allows configurable `stateDir`.

**OAuth discipline (mitigates corporate CA interception risk):**
- Perform all OAuth flows (Gmail, Google Calendar, GHE, Vercel, Neon) over cellular tether or home wifi, **never** the `dart_secure` corporate network. The DA-root CA is trusted system-wide and *can* be used for TLS interception on corp wifi.
- Once tokens are issued, their refresh flow uses cert-pinned endpoints in most SDKs — but the initial issuance is the window of exposure.

**Other:**
- Disable Screen Sharing and Remote Login (`System Settings → General → Sharing`) if not required for other work.
- Subscribe to OpenClaw GitHub security advisories: `github.com/openclaw/openclaw → Watch → Custom → Security alerts`.
- Weekly calendar reminder: `npm update -g openclaw` and verify version is ≥ latest security patch.
- `sudo log stream --predicate 'process == "openclaw"'` for a few minutes after first run to verify outbound hosts match expectations.

---

### Phase 4 — Enderfga Claude Code wrapper (1 day)

This is the unlock for "deploy a Claude Code session from the glasses."

```bash
git clone https://github.com/Enderfga/openclaw-claude-code ~/.openclaw/skills/claude-code-skill
cd ~/.openclaw/skills/claude-code-skill
npm install

# Verify your claude CLI is logged in with your Max account
claude --version
claude whoami   # should show your Max-subscribed account
```

Register it as an OpenClaw skill per the repo's README. The wrapper exposes an OpenAI-compatible endpoint that OpenClaw can invoke; because it shells out to the local `claude` binary, all sessions run against your Max subscription — no Anthropic API billing.

Test end-to-end before wiring in the glasses:
```
OpenClaw prompt → "Fix the lint error in the even-g2-claude relay-server"
                → Claude Code session spawns in the even-g2-claude repo directory
                → returns a PR-ready diff
```

---

### Phase 5 — MCP integrations (staged, 1-2 days total)

Integrate in this order — easiest-win first, highest-blast-radius last.

| Order | Integration | Effort | Blocker |
|---|---|---|---|
| 1 | **Vercel** | 30 min | OAuth setup in Vercel dashboard |
| 2 | **GHE** | 1 hr | Fine-grained PAT, `GITHUB_HOST` config |
| 3 | **Neon** | 30 min | Create read-only Postgres role first |
| 4 | **Google Calendar** | 2 hr | Google OAuth app in Testing mode |
| 5 | **iCalendar** | 1 hr | Write custom skill with `ical.js` |
| 6 | **Gmail** | 2 hr | Same OAuth app as Calendar; use `gmail.metadata` scope |

Details for each are in [`mcp-targets.md`](./mcp-targets.md). **Do not add Gmail until you've validated that Calendar + GHE + Vercel are stable** — Gmail read is the highest blast-radius integration and there's no upside in rushing it.

---

### Phase 6 — Burn-in (2 weeks, pre-glasses)

Before the glasses arrive, validate the stack by typing queries directly into OpenClaw:

- "What's on my calendar tomorrow?"
- "Any failed deployments on Vercel in the last 24 hours?"
- "How many users are in the `users` table on the Neon dev branch?"
- "Open a draft GHE issue titled 'test — delete me'"
- "Start a Claude Code session and list the files in even-g2-claude"

Track:
- API cost per day (Gemini dashboard + Anthropic usage page)
- Memory DB size growth (`du -sh ~/.openclaw/workspace`)
- Latency per query type (router-only vs escalated-to-Sonnet)
- Any MDM-triggered disruptions (forced reboots, policy pushes)

---

## 2. Risk Assessment

Re-graded after the `sudo profiles show -all` audit (2026-04-18).

### R1 — Employer read access to OpenClaw memory via TCC Full Disk Access (HIGH)

Mosyle TCC configuration profiles (#10, #14, #15, #22, #30) pre-grant the Mosyle agent Full Disk Access. It can read anything at rest, including `~/.openclaw/workspace` (memory DB), `~/.openclaw/openclaw.json` (if it held plaintext keys), cached OAuth tokens, and shell history.

**Exposure:** every personal email subject, every calendar event, every Neon query result that flows into OpenClaw's long-term memory is readable by the employer without notice.

**Mitigations (partial, not airtight):**
- Memory DB on encrypted sparseimage with passphrase outside Keychain (Phase 3).
- Scope integrations to work-adjacent only — **no Gmail, no personal iCalendar** on this machine. Calendar and GHE through work accounts are already in-scope for the employer anyway.
- Treat the MBP trial as a **proof of concept for workflow**, not a production brain. Personal data migration to real personal hardware (Mac Mini, home server, personal VPS) is the fix, not a config change here.

### R2 — Employer TLS interception via installed CA roots (MEDIUM)

Profiles #16 (`da-root.pem`) and #19 (`DA Root CA`) install Digital Artefacts CAs as trusted system-wide. On the `dart_secure` corporate wifi (profile #16 also configures this SSID), TLS interception is technically possible — the CA lets the corp proxy impersonate any hostname without browser warnings.

**Exposure:** browser-based OAuth flows on corp wifi can be MITM'd, leaking refresh tokens for Gmail, GHE, Calendar, Vercel, Neon.

**Mitigation:** all OAuth flows over **cellular tether or home wifi**, never on `dart_secure`. Most Claude Code / MCP SDK traffic uses cert-pinning, but browser OAuth does not. After initial token issuance, normal API traffic is low-risk.

### R3 — MDM remote wipe on offboarding (HIGH, recoverable with prep)

If you leave the role or the device is reclaimed, Mosyle wipes everything — including the encrypted sparseimage file. FileVault recovery key is escrowed to Mosyle (#8 payload[4]), so "I'll resurrect the disk offline" isn't an option either.

**Mitigation:** from day one, nightly encrypted backup of the sparseimage to personal cloud storage:

```bash
# Add to user crontab — nightly at 2am, only if OpenClaw is mounted
0 2 * * * /usr/local/bin/openclaw-backup.sh
```

`openclaw-backup.sh`:
```bash
#!/bin/bash
set -euo pipefail
SRC=~/openclaw-workspace.sparseimage
if [ ! -f "$SRC" ]; then exit 0; fi
STAMP=$(date +%Y%m%d)
# Sparseimage is already encrypted; we still add a second passphrase for cloud at rest
rclone copy "$SRC" personal-b2:openclaw-backups/ --transfers 1 --checksum
echo "$(date -u) — backed up" >> ~/.openclaw/backup.log
```

Keep the sparseimage passphrase and rclone config in your **personal** 1Password / Bitwarden, never in macOS Keychain (Keychain wipes with the device).

### R4 — Acceptable-use policy (MEDIUM, legal/political)

Running personal workloads on work hardware is in a gray zone. Mosyle telemetry (profile #12 `Mosyle Diagnostic Report`, profile #29 `Mosyle Push`) reports back to IT. OpenClaw will show up in app inventory as a Node global install.

**Mitigation:** this is why R1's scoping matters — if the only things OpenClaw sees are work-adjacent (GHE, Vercel, Neon dev branches), the acceptable-use posture is comparable to running Claude Code itself (which you already do on this machine). Keep it in that shape until a move to personal hardware.

### R5 — Forced OS updates / reboots (MEDIUM, operational)

Mosyle Software Update profile (#24) controls update cadence; forced reboots will kill in-progress Claude Code sessions.

**Mitigation:**
- `KeepAlive: true` on the OpenClaw LaunchAgent so the gateway auto-restarts.
- Claude Code sessions are stateless per-invocation; a mid-run reboot loses in-progress agent work but cannot corrupt the memory DB (SQLite WAL is crash-safe).
- Check the enforcement window in the Mosyle portal; schedule long sessions outside it.

### R6 — Tailscale blocked (MEDIUM, but looks unlikely given audit)

No VPN-blocking, content-filter, or network-extension-denial profile was found. Tailscale **should** install and connect. Still possible Mosyle pushes a new profile later.

**Mitigation:** Phase 0 Gate A tests this. If it ever stops working, you need a different host — do not try to work around Mosyle policy on work hardware.

### R7 — SSD / hardware wear (LOW, long-term)

Continuous writes on a 2019 MBP SSD. The 2019 Intel MBPs also had well-documented GPU (Radeon 5500M/5600M) and logic-board failures under heat.

**Mitigation:** well-ventilated spot, fan-side unobstructed, monthly `sudo smartctl -a /dev/disk0`. If SMART reports reallocated sectors, migrate immediately.

### R8 — macOS end-of-life (LOW, future)

Sequoia (15) is likely the last macOS for a 2019 Intel MBP. Apple security patches end around 2027.

### R9 — OpenClaw CVEs (MEDIUM, ongoing)

See `oculaw-openclaw.md` for full CVE history. Pin ≥ 2026.2.25, subscribe to advisories, patch weekly. MBP trial has no upstream buffer — you are the ops team.

### Risk summary

| # | Risk | Rating |
|---|---|---|
| R1 | Employer TCC Full Disk Access → memory DB readable | **HIGH** |
| R3 | MDM remote wipe on offboarding | **HIGH** |
| R2 | TLS interception via corp CA on dart_secure wifi | MEDIUM |
| R4 | Acceptable-use policy exposure | MEDIUM |
| R5 | Forced OS updates / reboots | MEDIUM |
| R6 | Tailscale blocked (audit suggests no, still worth Gate A) | MEDIUM |
| R9 | OpenClaw CVEs | MEDIUM |
| R7 | Hardware wear | LOW |
| R8 | macOS EOL | LOW |

---

## 3. Features and Connectors

Full per-integration details are in [`mcp-targets.md`](./mcp-targets.md). This section tracks what's enabled, what's staged, and what's deferred.

Scoping rule for this machine (driven by R1 — employer TCC read access): **work-adjacent integrations only**. Personal Gmail and personal iCalendar are out until the stack moves to personal hardware.

### Active on the MBP (roll out in Phase 5)

| Connector | Mode | Scope | MCP Server |
|---|---|---|---|
| Vercel | Read | Deployments, build status, env var names (not values) | Official hosted: `https://mcp.vercel.com/` |
| GHE | Read | PRs, issues, CI status, file contents | `github/github-mcp-server` local binary, `--read-only --toolsets repos,issues,pull_requests` |
| Neon | Read | SELECT queries against named non-prod branches | `neondatabase/mcp-server-neon` hosted, dedicated read-only Postgres role |
| Google Calendar (work account only) | Read | Upcoming events, next 7 days | `taylorwilsdon/google_workspace_mcp`, `calendar.readonly` scope — only your work Google account, never personal |

### Blocked on the MBP — move with the stack to personal hardware

| Connector | Reason it's blocked here |
|---|---|
| Gmail (any account) | Memory would ingest sender/subject/body into TCC-readable store. Metadata scope mitigates body but not sender/subject — still too much personal signal on work hardware. |
| Personal Google Calendar | Same as above for personal events. |
| iCalendar subscription feeds | Typically personal (family, sports, hobbies) — same reasoning. |

### Deferred (post-glasses or post-hardware-move)

| Connector | Mode | Note |
|---|---|---|
| GHE write (create issue, post comment) | Write | Add write PAT scope separately from read; gate via approval prompt |
| Slack | Read/write | Natural glasses use case, not scoped yet |
| Calendar write | Write | High risk of accidental event creation via voice; not MBP-blocked, just not prioritized |

### Claude Code skill

The Enderfga wrapper (`~/.openclaw/skills/claude-code-skill`) is a pseudo-connector: it lets OpenClaw invoke a real Claude Code CLI session against any local repo. On the MBP, the `even-g2-claude` repo is the primary target. Use cases:

- "Investigate the relay-server WebSocket reconnect issue and propose a fix"
- "Open an issue for the flaky prompt parser test"
- "Summarize what changed in the last 5 commits on main"

This runs against your Max subscription; rate limits are the same as interactive Claude Code usage.

---

## 4. Future integrations with OcuClaw (once the glasses arrive)

These steps pick up where Phase 6 burn-in ends.

### Step 1 — Install OcuClaw plugin into OpenClaw

```bash
# Install the OcuClaw npm plugin into OpenClaw's plugin directory
npm install -g ocuclaw   # or per OpenClaw plugin install docs

# Add to ~/.openclaw/openclaw.json plugins section
# (exact key confirmed by checking openclaw.plugin.json in the ocuclaw tarball)
```

Configure the plugin (`~/.openclaw/openclaw.json` or per-plugin config):

```jsonc
{
  "ocuclaw": {
    "wsBind": "127.0.0.1",    // NEVER 0.0.0.0
    "wsPort": 9000,
    "relayToken": "<generate: openssl rand -hex 32>",
    "gatewayToken": "<same as gateway.auth.token above>",
    "stateDir": "~/.openclaw/ocuclaw",
    "sonioxApiKey": "<from keychain>",
    "evenAiEnabled": false,   // leave off until explicitly needed
    "externalDebugToolsEnabled": false
  }
}
```

### Step 2 — Phone app

1. Install "OcuClaw" from the Even Hub App Store on the paired iPhone/Android.
2. In the app's settings, enter:
   - **Relay URL:** `ws://100.x.y.z:9000` — the MBP's **Tailscale** IP, not the LAN IP
   - **Relay token:** same `relayToken` from above
3. The phone must be on the same Tailscale tailnet as the MBP.

### Step 3 — Add session-token layer

The OcuClaw downstream relay uses a shared `relayToken` with no rotation story. Layer this repo's session-token pattern on top via a lightweight reverse proxy on the MBP:

```
Phone app → wss://100.x.y.z:9001 (proxy: token exchange, session UUID, ban-on-fail)
                                  → ws://127.0.0.1:9000 (OcuClaw relay, loopback only)
```

The proxy is small (~50 lines of Node, mirrors `relay-server/server.js`). This keeps OcuClaw's relay off the network entirely — only the proxy is on the tailnet IP.

### Step 4 — Voice query path

End-to-end for "What are my new emails in gmail?":

```
G2 mic → Even Hub app → Soniox STT (phone-side) → "What are my new emails in gmail"
       → OcuClaw relay (ws://127.0.0.1:9000 on MBP)
       → OpenClaw gateway (ws://127.0.0.1:18789)
       → Gemini 2.5 Flash-Lite (routes to Gmail MCP)
       → Gmail MCP → metadata for N unread messages
       → Sonnet 4.6 summarizes if needed
       → Response streamed back through relay → G2 display
```

### Step 5 — Claude Code voice sessions

End-to-end for "Deploy a Claude Code session to address issue #42 in even-g2-claude":

```
G2 voice → OcuClaw relay → OpenClaw gateway
         → Enderfga wrapper → claude CLI (Max auth)
         → Claude Code agent runs: reads issue #42, opens repo, makes changes, opens PR
         → Session output streams back to glasses as activity events
         → Completion summary displayed on G2
```

This is the highest-value flow and requires the burn-in period to be stable before trusting it with real work.

### Step 6 — Validation on first day with glasses

Run these in order on day one:

1. "What time is my first meeting tomorrow?" — Calendar MCP, low blast-radius
2. "Any Vercel deployment failures in the last hour?" — Vercel MCP
3. "How many rows in the users table on the dev branch?" — Neon MCP
4. "What's in my inbox from this morning?" — Gmail MCP (metadata only)
5. "Create a test GHE issue titled 'glasses test — delete me'" — First write operation
6. "Start a Claude Code session on even-g2-claude and show me recent commits" — Enderfga skill

Do not test voice-triggered Claude Code sessions in a production context (real PRs, real data writes) until step 1-5 are stable.

---

## References

- OpenClaw: https://github.com/openclaw/openclaw
- OpenClaw Ansible hardening: https://github.com/openclaw/openclaw-ansible
- Enderfga Claude Code wrapper: https://github.com/Enderfga/openclaw-claude-code
- OcuClaw npm: https://registry.npmjs.org/ocuclaw/-/ocuclaw-1.2.4.tgz
- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- OpenClaw CVE tracker: https://github.com/jgamblin/OpenClawCVEs
- MCP integrations detail: [mcp-targets.md](./mcp-targets.md)
- OcuClaw architecture detail: [oculaw-openclaw.md](./oculaw-openclaw.md)
