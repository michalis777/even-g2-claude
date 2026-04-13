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
- **Glasses plugin** (`glasses-plugin/src/main.ts`) — Even Hub SDK TypeScript app running in a WebView on the phone. Connects to the relay, renders terminal output line-by-line across the 576×288 display. Two modes: **scroll** (no active prompt — scroll ▲▼ moves viewport one line, double-tap jumps to latest) and **choice** (choice prompt active — scroll ▲▼ moves the selection cursor, tap confirms, double-tap cancels locally).

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

**Phase 2 complete (2026-04-12):** Verified end-to-end against real Claude Code in the Even Hub simulator. Scroll, numbered-choice rendering, arrow-key resolution of confirmation dialogs, and the prompt-state-gated whitelist all work. Voice input for free-form text prompts is the Phase 3 extension (deferred).

## Running the PoC (Simulator)

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
```

## Planned Extensions

- [ ] **Phase 3 — voice input** for free-form text prompts via the phone WebView's Web Speech API → relay → tmux. Trigger gesture TBD; will be designed after living with Phase 2 for a bit.
- [ ] Output summarization: Claude API from within the plugin to compress long diffs
- [ ] Multiple tmux session switching
- [ ] Structured approval events emitted directly by Claude Code (vs parsing them out of rendered tmux output)

## Structure

- `relay-server/` — Node.js WebSocket relay (`server.js` holds all logic; `samples/` contains raw tmux captures used as parser fixtures)
- `glasses-plugin/` — Even Hub SDK plugin, TypeScript + Vite (`src/main.ts` holds all logic)
- `HANDOFF.md` — Detailed design context, key decisions, and open questions
- `CLAUDE.md` — Guidance for Claude Code when editing this repo

## Related Links

- Even Hub SDK: https://www.npmjs.com/package/@evenrealities/even_hub_sdk
- Even Hub Docs: https://hub.evenrealities.com/docs
- Even Hub Simulator: `npx @evenrealities/evenhub-simulator`
