# Claude Code Glasses — Session Handoff

This document captures the full context of the design session that produced this codebase, so a new Claude Code session can pick up without losing context.

---

## What This Project Is

A PoC that lets you monitor and interact with Claude Code terminal sessions on **Even Realities G2 smart glasses** — without needing the glasses to build and test it. The Even Hub simulator covers the full development loop.

The use case is **monitor + selective read, with occasional steering** — not a full terminal replacement. You glance at what Claude Code is doing, scroll through output, and tap to approve/reject prompts. Voice input is a planned extension for anything beyond y/n.

---

## Architecture

```
┌─────────────────┐        WebSocket        ┌──────────────────────┐
│  Claude Code    │──── relay-server ───────►│  Even Hub Plugin     │
│  (tmux on PC)   │◄── y/n only ─────────────│  (phone WebView)     │
└─────────────────┘                          └──────────┬───────────┘
                                                        │ Even Hub SDK
                                                        ▼
                                             ┌──────────────────────┐
                                             │  G2 Glasses Display  │
                                             │  576×288 greyscale   │
                                             └──────────────────────┘
```

- **Relay server** (`relay-server/server.js`) — Node.js WebSocket server running on your PC. Polls Claude Code's tmux session via `tmux capture-pane`, detects approval prompts via regex, and serves output to the plugin. Accepts only `y` and `n` back.
- **Glasses plugin** (`glasses-plugin/src/main.ts`) — Even Hub SDK TypeScript app running in a WebView on the phone. Connects to the relay, paginates terminal output into 8-line pages across the 576×288 display, maps touchpad gestures to scroll/approve/reject.

---

## Key Design Decisions

**Why tmux capture-pane?**
It's the cleanest way to tail a running Claude Code session without modifying how Claude Code is invoked. The relay polls every 500ms and diffs against a rolling hash to avoid redundant broadcasts.

**Why only y/n commands?**
The command surface exposed to the glasses is intentionally minimal. A generic `command` passthrough was considered and explicitly removed — if the relay WebSocket were ever compromised, the blast radius is limited to two keystrokes. Voice-to-text for richer input is the planned extension, still going through the relay's whitelist.

**Why session tokens?**
The master `RELAY_TOKEN` is only ever sent once (full auth). After that, the server issues a UUID session token that gets stored in Even Hub's local storage (`bridge.setLocalStorage`). All reconnects use the session token instead. Sessions expire after 30 days; server restart invalidates all sessions and triggers one silent re-auth.

**Why not ngrok by default?**
Tailscale is the recommended transport — the relay stays on a private VPN, no public surface. ngrok works but requires `wss://` (which the plugin enforces automatically for non-localhost URLs) and ideally `ALLOWED_IPS` set to the phone's IP.

---

## Security Model

| Layer | Mechanism |
|---|---|
| Authentication | Master token → server issues session UUID; stored in glasses local storage |
| Reconnects | Session token only — master token not retransmitted |
| Brute force | IP banned after 3 failed token attempts |
| Command surface | Only `y` and `n` ever reach tmux — whitelist enforced in `sendToTmux()` |
| Transport | `wss://` enforced for non-localhost; Tailscale preferred |
| IP restriction | Optional `ALLOWED_IPS` env var |
| Memory only | Terminal output never written to disk on the relay |
| Timing attacks | `crypto.timingSafeEqual` for token comparison |

---

## File Structure

```
claudecode-glasses/
├── HANDOFF.md                        ← this file
├── README.md                         ← setup + usage instructions
├── relay-server/
│   ├── server.js                     ← WebSocket relay (Node.js, no framework)
│   ├── mock-feed.js                  ← automated test: feeds timed lines into relay stdin
│   └── package.json                  ← single dependency: ws
└── glasses-plugin/
    ├── src/
    │   └── main.ts                   ← Even Hub SDK plugin (all logic here)
    ├── index.html                    ← entry point + RELAY_CONFIG injection
    ├── app.json                      ← Even Hub manifest
    ├── package.json
    ├── vite.config.ts
    └── tsconfig.json
```

---

## Current State

First runtime test completed 2026-04-11 against the Even Hub simulator.

**Verified working (runtime-tested):**
- Relay server starts in `--stdin-mock` mode and accepts WebSocket connections
- Auth flow: master token → session UUID issuance works end-to-end
- Session resume: plugin reconnects with saved session token, falls back to full auth on expiry
- Terminal output streams from relay to plugin and renders on simulator display
- Paginated display: text containers render correctly, pagination (pg 1/2, 2/2) works
- Swipe up/down gestures navigate pages correctly in the simulator
- Approval detection: relay correctly sets `approvalPending=true` when terminal output matches patterns (e.g. "Do you want to proceed? (y/n)")
- `mock-feed.js` helper script for automated test sequences (feeds timed lines to relay stdin)

**Partially working / needs investigation:**
- Click/double-click gestures: click fires an event but behavior unclear; double-click had no visible effect. Debug logging added to `main.ts` (`[event] raw:` lines) to diagnose on next test run. Likely an event shape mismatch between simulator and the expected `textEvent`/`sysEvent` paths.
- Status bar does not visually switch to "!! APPROVE" state during testing — may be related to the click event issue or a rendering timing problem

**Not yet built (planned extensions):**
- Voice input via `bridge.audioControl` → speech-to-text → relay → tmux
- Output summarization: call Claude API from within the plugin to compress long diffs before rendering
- Multiple tmux session switching
- Structured approval events from Claude Code (rather than regex detection)

---

## Even Hub SDK Notes

The G2 hardware that matters for this project:

- Display: 576×288 px per eye, 4-bit greyscale (16 shades of green)
- Input: press, double press, swipe up, swipe down (temple touchpads + optional R1 ring)
- Audio: 4-mic array, 16kHz PCM mono — available via `bridge.audioControl(true)`
- No camera, no speaker, no arbitrary pixel drawing
- App logic runs in a WebView on the phone; glasses handle rendering + input only
- SDK bridge: `waitForEvenAppBridge()` → `EvenAppBridge` instance
- Local storage: `bridge.setLocalStorage(key, value)` / `bridge.getLocalStorage(key)`
- Events: `bridge.onEvenHubEvent(cb)` — `OsEventTypeList.CLICK_EVENT`, `DOUBLE_CLICK_EVENT`, `SCROLL_TOP_EVENT`, `SCROLL_BOTTOM_EVENT`

Simulator: `npx @evenrealities/evenhub-simulator http://localhost:5173` — renders the glasses display on screen, keyboard-triggerable input events. No hardware needed for PoC.

Docs: https://hub.evenrealities.com/docs

---

## To Run the PoC (Simulator, No Glasses)

```bash
# 1. Generate and export token
export RELAY_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 2. Start relay (stdin-mock = no tmux needed for testing)
cd relay-server && npm install && node server.js --stdin-mock

# 3. Start plugin dev server (new terminal)
cd glasses-plugin && npm install && npm run dev

# 4. Launch simulator (new terminal)
npx @evenrealities/evenhub-simulator http://localhost:5173

# 5. Simulate terminal output by typing into terminal 2's stdin
#    e.g.: Do you want to proceed? [y/n]
```

For real Claude Code use, replace step 2 with:
```bash
tmux new-session -s claudecode
# ... start Claude Code in that session ...
node server.js --tmux-session claudecode --tmux-window 0
```

---

## Open Questions / Decisions for Next Session

1. **Click/double-click event debugging** — top priority. Debug logging is in place (`main.ts` lines with `[event] raw:`). Open the simulator's DevTools console, click the buttons, and inspect the event shape. Likely fix: the simulator sends events on a path the code doesn't check (e.g. `appEvent` instead of `textEvent`/`sysEvent`), or the `eventType` enum values differ.
2. **Approval status bar** — verify whether the "!! APPROVE" status text appears. The relay sends `approvalPending=true` correctly; check if the plugin receives it before the display re-renders.
3. **Voice input priority** — is mic → speech-to-text → relay the next feature after click/approve works?
4. **Speech-to-text service** — Whisper local vs. a cloud API? Latency vs. privacy tradeoff given terminal output may contain sensitive data.
5. **Approval pattern tuning** — the regex list in `server.js` (`APPROVAL_PATTERNS`) was written generically. Once tested against real Claude Code output, these will likely need adjustment.
6. **Display font size** — 8 lines per page at ~12px looked readable in the simulator, but needs validation on actual glasses hardware.
7. **Session TTL** — 30 days is the default. Adjust `CONFIG.sessionTtlMs` in `server.js` if tighter expiry is preferred.
