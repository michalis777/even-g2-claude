# Claude Code Glasses — Session Handoff

This document captures the full context of the design session that produced this codebase, so a new Claude Code session can pick up without losing context.

---

## What This Project Is

A PoC that lets you monitor and interact with Claude Code terminal sessions on **Even Realities G2 smart glasses** — without needing the glasses to build and test it. The Even Hub simulator covers the full development loop.

The use case is **monitor + selective read, with occasional steering** — not a full terminal replacement. You glance at what Claude Code is doing, scroll line-by-line through output, and resolve Claude's confirmation dialogs from the glasses — including the multi-option numbered widgets that modern Claude Code uses for every approval. Voice input for free-form text prompts is a planned extension (Phase 3).

---

## Architecture

```
┌─────────────────┐         WebSocket         ┌──────────────────────┐
│  Claude Code    │───── relay-server ───────►│  Even Hub Plugin     │
│  (tmux on PC)   │◄── prompt-gated keys ─────│  (phone WebView)     │
└─────────────────┘                           └──────────┬───────────┘
                                                         │ Even Hub SDK
                                                         ▼
                                              ┌──────────────────────┐
                                              │  G2 Glasses Display  │
                                              │  576×288 greyscale   │
                                              └──────────────────────┘
```

- **Relay server** (`relay-server/server.js`) — Node.js WebSocket server running on your PC. Polls Claude Code's tmux session via `tmux capture-pane`, parses the output into a structured `Prompt` object via `detectPrompt()` (anchors on the "Esc to cancel" footer and walks upward collecting numbered options, using the `❯` marker to capture the real cursor position), and serves output + current prompt to the plugin. The command surface back to tmux is **prompt-state-gated**: y/n reach tmux only when a yn prompt is active, and arrow-key navigation (`Up`/`Down`/`Enter`) only when a choice prompt is active, with the keystroke count bounded by the parsed option count.
- **Glasses plugin** (`glasses-plugin/src/main.ts`) — Even Hub SDK TypeScript app running in a WebView on the phone. Connects to the relay, renders terminal output line-by-line (8 visible lines, 58 chars/line) across the 576×288 display. Two UI modes: **scroll mode** (no prompt active — scroll ▲▼ moves the viewport one line at a time, double-tap jumps to latest) and **choice mode** (choice prompt active — scroll ▲▼ moves the local selection cursor, tap sends `{ type: 'choice', index }` to the relay, double-tap cancels locally).

---

## Key Design Decisions

**Why tmux capture-pane?**
It's the cleanest way to tail a running Claude Code session without modifying how Claude Code is invoked. The relay polls every 500ms and diffs against a rolling hash to avoid redundant broadcasts.

**Why prompt-state-gated keys instead of a generic command passthrough?**
The command surface exposed to the glasses is intentionally minimal. A generic `command` passthrough was considered and explicitly removed. The current model is: the relay parses the live terminal into a structured `Prompt` object, and only allows keystrokes that correspond to a valid resolution of *that specific prompt* at *that specific moment*. For choice prompts, only `Up`/`Down`/`Enter` can ever reach tmux, and the number of arrow keys is bounded by what the relay's own parser says is needed to move between the parsed cursor position and the user's pick. Even if the WebSocket were compromised, an attacker could only resolve whatever dialog Claude Code is currently showing — never inject arbitrary text or commands. Voice-to-text for free-form text prompts is the planned extension (Phase 3), and will add a separate gated path.

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
| Command surface | Prompt-state-gated: `y`/`n` only when a `yn` prompt is active, `Up`/`Down`/`Enter` only when a `choice` prompt is active and the arrow count matches the parsed option index — enforced in `isCommandAllowed()` + `ALLOWED_KEYS` |
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
├── CLAUDE.md                         ← guidance for Claude Code when editing this repo
├── relay-server/
│   ├── server.js                     ← WebSocket relay (Node.js, no framework)
│   ├── samples/                      ← raw tmux capture-pane fixtures for parser development
│   │   ├── choice.txt                ← Claude Code's numbered confirmation widget
│   │   └── bash.txt                  ← "no prompt active" baseline
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

Phase 2 complete 2026-04-12. Fully verified end-to-end against **real** Claude Code running in tmux (not `--stdin-mock`) via the Even Hub simulator.

**Verified working (runtime-tested against real Claude Code):**
- Relay server in real tmux mode polls `tmux capture-pane` and streams output to the plugin
- Auth flow: master token → session UUID issuance, and session resume with automatic fallback to full auth on server restart
- Line-by-line scroll on the glasses (replaces the original page-by-page) with auto-follow-latest
- `detectPrompt()` parser correctly extracts Claude Code's numbered-choice widget (question line, options, cursor position from the `❯` marker) from the live tmux buffer
- Choice-mode UI: question + numbered options render on the glasses with a `▶` highlight on the local selection cursor
- Scroll ▲▼ moves the selection cursor; tap sends `{ type: 'choice', index }`; double-tap cancels locally
- `resolveChoice()` computes the `Down`/`Up` keystroke delta from the real Claude Code cursor to the user's pick and sends the sequence via `tmux send-keys`, after which Claude Code advances and the display flips back to scroll mode on the next 500ms poll
- Prompt-state-gated whitelist: arbitrary text, commands, or out-of-range indexes are rejected at the relay before ever reaching tmux

**Not yet built (planned extensions):**
- Voice input for free-form text prompts via the WebView's Web Speech API → relay → tmux (Phase 3 — deferred until the choice-mode flow has been used enough to inform the voice-trigger gesture UX; see `~/.claude/plans/delegated-herding-pizza.md`)
- Output summarization: call Claude API from within the plugin to compress long diffs before rendering
- Multiple tmux session switching
- Structured approval events emitted directly by Claude Code (rather than parsing them back out of the rendered tmux output)

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

**Resolved in Phase 2:**
- ~~Click/double-click event debugging~~ — Click events were reaching the plugin all along; the real bug was that `tmux send-keys "1" Enter` inserted the digit as literal text into Claude Code's main chat input instead of selecting the widget option. Fixed by switching to arrow-key navigation + Enter via `resolveChoice()`.
- ~~Approval status bar~~ — Replaced by structured `Prompt` state; choice prompts now render their own dedicated UI on the glasses.
- ~~Approval pattern tuning~~ — The legacy `APPROVAL_PATTERNS` list never fires against modern Claude Code (which uses the numbered widget for everything). Kept as a legacy fallback only. The new `detectPrompt` parser anchors on the `Esc to cancel` footer and is driven by the fixture in `relay-server/samples/choice.txt`.

**Still open:**
1. **Voice input (Phase 3)** — design pass deferred until the Phase 2 choice flow has been used enough to inform the trigger-gesture UX. The STT path has already been decided: Web Speech API in the phone WebView, zero new infra. See `~/.claude/plans/delegated-herding-pizza.md` for the Phase 3 sketch.
2. **Display font size** — 8 visible lines at ~12px looked readable in the simulator, but needs validation on actual glasses hardware.
3. **Session TTL** — 30 days is the default. Adjust `CONFIG.sessionTtlMs` in `server.js` if tighter expiry is preferred.
4. **Parser robustness against wider variety of Claude Code prompts** — `samples/choice.txt` covers a file-write confirmation; `samples/bash.txt` inadvertently confirmed that `ls` is on Claude Code's auto-allow list (no prompt needed). More exotic prompts (destructive bash, MCP-tool approvals, etc.) may have subtly different shapes. If the parser breaks on a new prompt type, capture a new sample in `relay-server/samples/` and extend the regex.
