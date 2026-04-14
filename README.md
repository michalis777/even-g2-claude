# Even G2 Claude — Smart Glasses for Claude Code

Project created on: 2026-04-11

#type/project #status/active #priority/medium #topic/tech #year/2026

## Overview

A proof-of-concept that enables monitoring and interaction with Claude Code terminal sessions on **Even Realities G2 smart glasses** — without needing the physical hardware to develop and test. The Even Hub simulator covers the full development loop.

The use case is **monitor + selective read, with occasional steering** — not a full terminal replacement. You glance at what Claude Code is doing, scroll line-by-line through output, and resolve Claude's confirmation dialogs — including the multi-option numbered widgets Claude Code uses for every approval — right from the glasses. Voice input for free-form text prompts is a planned Phase 3 extension.

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

### Components

- **Relay server** (`relay-server/server.js`) — Node.js WebSocket server running on your PC. Polls Claude Code's tmux session via `tmux capture-pane`, parses the output into a structured `Prompt` object, and serves it to the plugin. The command surface back to tmux is **prompt-state-gated**: y/n reach tmux only when a yn prompt is active, and arrow-key navigation (`Up`/`Down`/`Enter`) only when a choice prompt is active.
- **Glasses plugin** (`glasses-plugin/src/main.ts`) — Even Hub SDK TypeScript app running in a WebView on the phone. Connects to the relay, renders terminal output line-by-line into a single full-display text container (status row + ~13 content lines + optional hints row). Two modes: **scroll** (no active prompt — scroll ▲▼ moves viewport one line, double-tap jumps to latest) and **choice** (choice prompt active — scroll ▲▼ moves the selection cursor, tap confirms, double-tap cancels locally).

## Project Lead
- **Mike Kantartjis** — AI&I Team (personal project / innovation exploration)

## Key Design Decisions

- **tmux capture-pane** for session tailing — cleanest non-invasive approach
- **Prompt-state-gated command surface** — the relay parses live terminal output into a structured `Prompt` object and only allows the specific keystrokes that resolve *that* prompt at *that* moment. A compromised WebSocket can at most resolve whatever dialog is currently on screen, never inject arbitrary commands.
- **Arrow-key navigation for choice prompts** — Claude Code's confirmation widgets use arrow keys + Enter, not digit-typing. The relay computes the `Up`/`Down` delta from the real cursor position (parsed from the `❯` marker) to the user's pick.
- **Session tokens** — master token sent once, then UUID session tokens for reconnects (30-day TTL)
- **Tailscale preferred** over ngrok — private VPN, no public surface

## Security Model

| Layer | Mechanism |
|---|---|
| Authentication | Master token → session UUID; stored in glasses local storage |
| Reconnects | Session token only — master token not retransmitted |
| Brute force | IP banned after 3 failed token attempts |
| Command surface | Prompt-state-gated: y/n only on yn prompts, `Up`/`Down`/`Enter` only on choice prompts with in-range arrow counts |
| Transport | `wss://` enforced for non-localhost; Tailscale preferred |

## Current State

**Phase 2 complete (2026-04-12).** Verified end-to-end against real Claude Code in the Even Hub simulator. Scroll, numbered-choice rendering, arrow-key resolution of confirmation dialogs, and the prompt-state-gated whitelist all work. Single-container display layout pushes ~+5 lines of content density vs. the original three-zone bordered look.

**Dev ergonomics (2026-04-13).** Added `/jarvis-init` and `/jarvis-kill` project-level slash commands that bootstrap and tear down the full dev stack (tmux + Claude Code + relay + Vite + Even Hub simulator + an auto-opened Terminal.app window attached to the tmux session) in one go.

**Phase 3a (phone text input) is the active next planning pass** — the glasses alone have no affordance for *initiating* new requests to Claude Code, only for resolving prompts. The plan is to render a text-input UI in the phone WebView's DOM (alongside the existing glasses-bound bridge rendering) so the phone becomes the compose surface while the glasses stay as the monitor + approval surface. Voice input (the original "Phase 3") gets pushed to Phase 3b as an additive input method layered on top.

## Running the PoC

### One-shot (recommended)

Inside Claude Code, invoke the project skill:

```
/jarvis-init
```

The skill spins up the entire stack — kills any stale processes, creates a tmux session with Claude Code running inside it, starts the relay / Vite dev server / Even Hub simulator as background tasks, and pops a new Terminal.app window already attached to the tmux session so you have somewhere to type requests. Reports a single status block when done. Run `/jarvis-kill` for a symmetric teardown.

Claude Code discovers user-invocable skills at startup, so after cloning the repo (or creating new skills) you must restart Claude Code before the slash commands become available.

### Manual

```bash
# 1. Token
export RELAY_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 2. Real Claude Code in tmux
tmux new-session -d -s claudecode -x 120 -y 30
tmux send-keys -t claudecode "cd $(pwd) && claude" Enter

# 3. Relay (against the real tmux session above)
cd relay-server && npm install && node server.js &

# 4. Vite dev server (new terminal)
cd glasses-plugin && npm install && npm run dev &

# 5. Simulator (new terminal)
npx @evenrealities/evenhub-simulator "http://localhost:5173/#token=$RELAY_TOKEN&url=ws://localhost:3000" &

# 6. Attach to tmux to type requests
tmux attach -t claudecode
```

For parser development without real Claude Code, replace step 2+3 with `node server.js --stdin-mock` and type lines into the relay's stdin.

## Planned Extensions

- [ ] **Phase 3a — phone text input UI** rendered in the Even Hub plugin's WebView DOM alongside the existing glasses rendering, so the phone becomes the compose surface. New `{ type: 'text', content }` wire message, relay sanitization, idle-prompt detection. Active next planning pass.
- [ ] **Phase 3b — voice input** as an additive input method on top of Phase 3a: Web Speech API in the phone WebView, triggered either from the glasses (via a dedicated gesture) or from the phone UI.
- [ ] Output summarization: Claude API from within the plugin to compress long diffs
- [ ] Multiple tmux session switching
- [ ] Structured approval events emitted directly by Claude Code (vs parsing them out of rendered tmux output)

## Structure

- `relay-server/` — Node.js WebSocket relay (`server.js` holds all logic; `samples/` contains raw tmux captures used as parser fixtures)
- `glasses-plugin/` — Even Hub SDK plugin, TypeScript + Vite (`src/main.ts` holds all logic)
- `.claude/skills/` — Project-level slash commands (`jarvis-init`, `jarvis-kill`)
- `HANDOFF.md` — Detailed design context, key decisions, and open questions
- `CLAUDE.md` — Guidance for Claude Code when editing this repo (local-only, gitignored)

## Related Links

- Even Hub SDK: https://www.npmjs.com/package/@evenrealities/even_hub_sdk
- Even Hub Docs: https://hub.evenrealities.com/docs
- Even Hub Simulator: `npx @evenrealities/evenhub-simulator`
