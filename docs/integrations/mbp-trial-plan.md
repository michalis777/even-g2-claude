# MBP Trial Plan — OpenClaw on 2019 Intel MacBook Pro

Deployment plan for running OpenClaw on the existing 2019 Intel MBP (32 GB RAM, always-on, office). Zero hardware spend. Covers pre-flight, install, hardening, integrations, and the OcuClaw handoff once the glasses arrive.

**Stack at a glance:**
- OpenClaw daemon bound to Tailscale IP only
- Router model: Gemini 2.5 Flash-Lite (cloud, ~$1-2/month)
- Reasoner: Claude Sonnet 4.6 via `Enderfga/openclaw-claude-code` wrapper → Max subscription (no API billing)
- Fallback: Gemini 2.5 Flash
- No local inference — Intel CPU makes it non-viable; all savings come from Max-backed Sonnet

---

## 1. Plan

### Phase 0 — Pre-flight (half day)

Verify the machine can actually run this before touching any config.

```bash
# Check admin rights
id              # should show staff + admin groups
sudo -v         # should succeed without error

# Check OS version (Sequoia = 15.x is fine; anything below 13 is a problem)
sw_vers

# Check Tailscale — most likely blocked by MDM firewall or restricted installs
# Try installing first before committing to any further phases
brew install --cask tailscale
tailscale up

# Check Node version
node --version  # need 22+; install via nvm if missing
nvm install 22 && nvm use 22

# Check if LaunchAgents are writable (needed for OpenClaw daemon auto-start)
ls -la ~/Library/LaunchAgents

# Check pfctl / firewall state
sudo pfctl -s info
```

If `tailscale up` is blocked by Mosyle network policy, stop — the whole secure-tunnel model depends on Tailscale. See Risk 1 in the risk section below.

If `sudo` requires a company-issued MDM approval prompt, note it but proceed — you'll still have full admin rights once approved.

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

The `openclaw/openclaw-ansible` playbook targets Linux (UFW + Docker). For macOS, apply the equivalent manually:

**macOS Application Firewall:**
```bash
# Enable firewall (may already be on via Mosyle)
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
# Block all incoming except explicitly allowed apps
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setblockall on
# Allow Tailscale and OpenClaw gateway explicitly
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /Applications/Tailscale.app/Contents/MacOS/Tailscale
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which node)
```

**Other hardening:**
- Disable Screen Sharing and Remote Login if not needed (`System Settings → General → Sharing`)
- Run `sudo log stream --predicate 'process == "openclaw"'` for a few minutes to verify no unexpected outbound hosts
- Subscribe to OpenClaw GitHub security advisories: `github.com/openclaw/openclaw → Watch → Custom → Security alerts`
- Set a weekly calendar reminder to run `npm update -g openclaw` and verify version is patched

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

### R1 — Mosyle blocks Tailscale (HIGH, mitigations exist)

Mosyle can enforce network filtering that intercepts or blocks VPN/tunnel traffic. Tailscale uses UDP port 41641 + DERP relay (TCP 443 fallback).

| Sub-risk | Likelihood | Mitigation |
|---|---|---|
| Tailscale UDP blocked | Medium | Tailscale auto-falls back to DERP over TCP 443; test before committing |
| Mosyle network filter logs Tailscale hostnames | Medium | Your tailnet traffic is encrypted end-to-end; Mosyle sees the connection, not the content |
| MDM policy explicitly forbids VPN client installs | Low | You said no one monitors — but check `sudo profiles show -all` for relevant payloads |

**Pre-flight test:** run `tailscale ping <your-phone>` from the MBP before starting Phase 1. If it works, proceed. If not, everything breaks and you need a different host.

### R2 — MDM remote wipe on offboarding (HIGH, recoverable with prep)

If you leave the role or the company reclaims the device, Mosyle wipe destroys everything: OpenClaw memory DB, config, installed tools, credentials.

**Mitigation:** from day one, daily encrypted backup of `~/.openclaw/workspace` (the SQLite memory store) to a personal location:

```bash
# Add to crontab — backs up every night at 2am
0 2 * * * tar czf - ~/.openclaw/workspace | openssl enc -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASS | rclone rcat personal-s3:openclaw-backups/workspace-$(date +%Y%m%d).tar.gz.enc
```

Store the `BACKUP_PASS` in your **personal** password manager, not macOS Keychain (Keychain is wiped with the device).

### R3 — Corporate acceptable-use policy (MEDIUM, legal/political)

Running personal workloads on work hardware is in a gray zone at most companies. If Mosyle telemetry reports app inventory to IT, OpenClaw will show up.

**Exposure:** OpenClaw's memory will contain personal data (Gmail content, calendar events, Neon rows). That data technically lives on company hardware.

**Mitigation:** Keep Gmail disabled until you've moved this to personal hardware. Calendar and GHE are lower risk (work-adjacent anyway). This risk is the primary reason to treat the MBP as a **temporary** trial, not a permanent home.

### R4 — Forced OS updates / reboots (MEDIUM, operational)

Mosyle can push required updates and enforce reboots. A reboot mid-Claude Code session would kill the Enderfga wrapper and any in-progress agent work.

**Mitigation:**
- Set `openclaw gateway` LaunchAgent to restart on exit (`KeepAlive: true` in the plist)
- Claude Code sessions are stateless per-invocation; partial work is lost but safe (no data corruption)
- Check Mosyle's update enforcement window — if it's business-hours-only, schedule long Claude Code sessions for evenings

### R5 — SSD wear (LOW, long-term)

Continuous OpenClaw daemon + SQLite writes on a 2019 MBP SSD. The 2019 Intel MBPs also had well-documented GPU (Radeon 5500M/5600M) and logic board failures at elevated temperatures.

**Mitigation:** keep the MBP in a well-ventilated spot, fan side unobstructed. Check `sudo smartctl -a /dev/disk0` monthly. If SMART shows reallocated sectors, back up and plan the migration immediately.

### R6 — macOS end-of-life (LOW, future)

Sequoia (15) is likely the last macOS for the 2019 Intel MBP. Apple security patches for it will end in approximately 2027. If you're still running this in 2027+, move it.

### R7 — OpenClaw CVEs (MEDIUM, ongoing)

See `oculaw-openclaw.md` for full CVE history. Short version: pin to ≥ 2026.2.25, subscribe to advisories, patch weekly. The MBP trial has no upstream buffer — you're the ops team.

---

## 3. Features and Connectors

Full per-integration details are in [`mcp-targets.md`](./mcp-targets.md). This section tracks what's enabled, what's staged, and what's deferred.

### Active (roll out in Phase 5)

| Connector | Mode | Scope | MCP Server |
|---|---|---|---|
| Vercel | Read | Deployments, build status, env var names (not values) | Official hosted: `https://mcp.vercel.com/` |
| GHE | Read | PRs, issues, CI status, file contents | `github/github-mcp-server` local binary, `--read-only --toolsets repos,issues,pull_requests` |
| Neon | Read | SELECT queries against named non-prod branches | `neondatabase/mcp-server-neon` hosted, dedicated read-only Postgres role |
| Google Calendar | Read | Upcoming events, next 7 days | `taylorwilsdon/google_workspace_mcp`, `calendar.readonly` scope |
| iCalendar | Read | Subscription feeds (Apple Calendar, etc.) | Custom OpenClaw skill — `ical.js` fetch+parse, 14-day window |

### Staged (add after 2-week burn-in)

| Connector | Mode | Scope | Note |
|---|---|---|---|
| Gmail | Read | Metadata only (`gmail.metadata` scope — no body) | Highest blast-radius; add last, validate first |

### Deferred (post-glasses / post-MBP)

| Connector | Mode | Note |
|---|---|---|
| GHE write (create issue, post comment) | Write | Already in use-case wishlist; add write PAT scope separately from read PAT |
| Slack | Read/write | Natural glasses use case but not scoped yet |
| Calendar write | Write | Create events via voice — low priority, high risk of accidental events |

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
