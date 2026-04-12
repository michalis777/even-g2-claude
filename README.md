# Even G2 Claude — Smart Glasses for Claude Code

Project created on: 2026-04-11

#type/project #status/active #priority/medium #topic/tech #year/2026

## Overview

A proof-of-concept that enables monitoring and interaction with Claude Code terminal sessions on **Even Realities G2 smart glasses** — without needing the physical hardware to develop and test. The Even Hub simulator covers the full development loop.

The use case is **monitor + selective read, with occasional steering** — not a full terminal replacement. You glance at what Claude Code is doing, scroll through output, and tap to approve/reject prompts. Voice input is a planned extension for anything beyond y/n.

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

### Components

- **Relay server** (`scripts/server.js`) — Node.js WebSocket server running on your PC. Polls Claude Code's tmux session via `tmux capture-pane`, detects approval prompts via regex, and serves output to the plugin. Accepts only `y` and `n` back.
- **Glasses plugin** (`scripts/main.ts`) — Even Hub SDK TypeScript app running in a WebView on the phone. Connects to the relay, paginates terminal output into 8-line pages across the 576×288 display, maps touchpad gestures to scroll/approve/reject.

## Project Lead
- **Mike Kantartjis** — AI&I Team (personal project / innovation exploration)

## Key Design Decisions

- **tmux capture-pane** for session tailing — cleanest non-invasive approach
- **y/n only command surface** — intentionally minimal blast radius if relay WebSocket is compromised
- **Session tokens** — master token sent once, then UUID session tokens for reconnects (30-day TTL)
- **Tailscale preferred** over ngrok — private VPN, no public surface

## Security Model

| Layer | Mechanism |
|---|---|
| Authentication | Master token → session UUID; stored in glasses local storage |
| Reconnects | Session token only — master token not retransmitted |
| Brute force | IP banned after 3 failed token attempts |
| Command surface | Only `y` and `n` ever reach tmux |
| Transport | `wss://` enforced for non-localhost; Tailscale preferred |

## Current State

PoC codebase is complete (designed, not yet runtime-tested). Both files pass syntax/type checks. Next step is running against the Even Hub simulator.

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

- [ ] Voice input via `bridge.audioControl` → speech-to-text → relay → tmux
- [ ] Output summarization: Claude API from within plugin to compress long diffs
- [ ] Multiple tmux session switching
- [ ] Structured approval events from Claude Code (vs regex detection)

## Structure

- `scripts/` — Source code (relay server + glasses plugin)
- `reference/` — SDK documentation and external references
- `notes/` — Working notes and session logs
- `HANDOFF.md` — Original session handoff document

## Related Links

- Even Hub SDK: https://www.npmjs.com/package/@evenrealities/even_hub_sdk
- Even Hub Docs: https://hub.evenrealities.com/docs
- Even Hub Simulator: `npx @evenrealities/evenhub-simulator`
