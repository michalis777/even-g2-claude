# Integrations — Wishlist & Design Docs

Major-docs folder tracking the integration surface we want around Even G2 + Claude Code. Starts with OcuClaw/OpenClaw; grows as new glasses-side capabilities land.

## Docs in this folder

| Doc | Scope |
|---|---|
| [`oculaw-openclaw.md`](./oculaw-openclaw.md) | Architecture, deployment, and threat model for running an OpenClaw brain that OcuClaw-on-G2 talks to. |
| [`mcp-targets.md`](./mcp-targets.md) | Per-integration MCP-vs-API matrix for the six initial targets (Google Calendar, iCalendar, Gmail, GHE, Neon, Vercel). |

## Current wishlist

Read-mostly, single-user, security-first. Ordered by how urgent each feels for a day-to-day glasses assistant.

1. **OcuClaw + OpenClaw** — the backbone. Everything below plugs into OpenClaw as MCP servers or skills. See [`oculaw-openclaw.md`](./oculaw-openclaw.md).
2. **Google Calendar** (read) — upcoming events, "what's next," meeting context.
3. **iCalendar feeds** (read) — shared/subscription calendars (e.g., personal Apple Calendar subscriptions) that don't live in Google.
4. **Gmail** (read, metadata-preferred scope) — unread count, latest from named senders. Highest blast-radius item — scope tightly.
5. **GHE** (read) — recent PRs, review requests, CI status for the repos we actually care about.
6. **Neon** (read, non-prod branches only) — quick inspection of dev branches; never point at production.
7. **Vercel** (read) — recent deployments, build status.

Anything added here should include a short rationale, a `read` vs `write` scope note, and either an MCP server link or an API-fallback sketch.

## Related repo patterns to reuse

This repo already codifies a few security choices that the integration work should inherit rather than reinvent:

- **Tailscale over public exposure** — private tailnet, no public listener. See `README.md` → Security Model.
- **Token-gated WebSocket** — master token → session UUID; brute-force lockout after 3 failed attempts. Reuse the same shape for the OcuClaw downstream relay (`ws://:9000`).
- **Prompt-state-gated command surface** — the relay only accepts the keystrokes the current prompt needs. Directly transplantable to gating which MCP tools are callable from the glasses at a given time.

## Dev tooling — Compound Engineering plugin

Ideation in this folder uses the [EveryInc Compound Engineering plugin](https://github.com/EveryInc/compound-engineering-plugin) (`/ce:ideate`, `/ce:brainstorm`, `/ce:plan`, `/ce:work`, `/ce:review`, `/ce:compound`).

Install once per machine (user-typed in Claude Code; restart required after install):

```
/plugin marketplace add EveryInc/compound-engineering-plugin
/plugin install compound-engineering
/ce-setup
```

Not yet installed in this repo's session — all ideation so far has been via parallel research subagents, which is the fallback when CE isn't available.
