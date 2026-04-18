# MCP Targets — Per-Integration Matrix

Six initial integration targets for OpenClaw. Read-mostly scopes. MCP preferred where an official server exists; API fallback sketched otherwise.

## Summary matrix

| # | Integration | Official MCP? | Auth | Recommended shape |
|---|---|---|---|---|
| 1 | Google Calendar | No vendor MCP | OAuth 2.0 (`calendar.readonly`) | Community MCP (`taylorwilsdon/google_workspace_mcp`) — shared OAuth app with Gmail |
| 2 | iCalendar (.ics) | No | URL only (+ optional Basic/app-specific password for CalDAV) | Roll our own — trivial fetch + parse, no MCP ecosystem worth using |
| 3 | Gmail | No vendor MCP | OAuth 2.0 (`gmail.metadata` preferred over `gmail.readonly`) | Community MCP (`taylorwilsdon/google_workspace_mcp`) |
| 4 | GHE | [`github/github-mcp-server`](https://github.com/github/github-mcp-server) (official) | Fine-grained PAT or OAuth | Local binary with `GITHUB_HOST` + `--read-only --toolsets repos,issues,pull_requests` |
| 5 | Neon | [`neondatabase/mcp-server-neon`](https://github.com/neondatabase/mcp-server-neon) + hosted `https://mcp.neon.tech/mcp` | OAuth (hosted) or Neon API key | Hosted MCP + dedicated read-only Postgres role |
| 6 | Vercel | Official hosted `https://mcp.vercel.com/` | OAuth per-team | Hosted MCP, team-scoped token |

## 1. Google Calendar

- **MCP**: no first-party. Reputable community options:
  - [`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp) (~2.1k stars, covers Calendar + Gmail + Drive) — preferred because it shares OAuth with Gmail.
  - [`nspady/google-calendar-mcp`](https://github.com/nspady/google-calendar-mcp) (~1.1k stars, calendar-only).
- **Scopes (read-only)**: `https://www.googleapis.com/auth/calendar.readonly`, optionally `calendar.events.readonly` for event-level.
- **API fallback**: `GET /calendar/v3/calendars/primary/events?timeMin=<ISO>&singleEvents=true&orderBy=startTime&maxResults=10`. Tiny footprint; fine to implement as a one-file OpenClaw skill if we don't want community MCP in the loop.
- **Quota**: 1M queries/day, 500 qps/user. Single-user use doesn't approach limits.
- **Gotcha**: Google's "app verification" process is painful for public apps. For personal use, run the OAuth client in **Testing** mode and add yourself as a test user — refresh tokens will be invalidated every 7 days, which is worth budgeting for (or live with and re-auth weekly).

## 2. iCalendar (.ics)

- **MCP**: no ecosystem worth using. [`Legit-AI/calendar-mcp`](https://github.com/Legit-AI/calendar-mcp) has 2 stars — skip.
- **Recommended**: thin OpenClaw skill that does `fetch(url) → ical.js` (or Python `icalendar`) and returns the next N events. A ~50-line file.
- **Auth**: none for public feeds. CalDAV (iCloud shared calendars) needs an **app-specific password**, not the Apple ID password.
- **Gotchas**:
  - Apple subscription URLs are usually `webcal://` — swap to `https://` before fetching.
  - Feeds can be enormous (multi-year recurrence). Pre-filter to a 14-day window before handing events to the LLM.

## 3. Gmail

**Highest blast-radius integration in the stack.** Treat with corresponding care.

- **MCP**: no first-party. Options:
  - [`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp) (shared with Calendar, above).
  - [`GongRzhe/Gmail-MCP-Server`](https://github.com/GongRzhe/Gmail-MCP-Server) (~1.1k stars, Gmail-only).
- **Scope choice**: prefer `https://www.googleapis.com/auth/gmail.metadata` over `gmail.readonly`. Metadata-only gives us sender / subject / timestamp / labels but **blocks body and attachment reads** — a prompt-injected agent cannot exfiltrate message contents. Upgrade to `gmail.readonly` only if a specific task demands it, and document the session scope.
- **API fallback**: `users.messages.list?q=is:unread&maxResults=20` + `users.messages.get?format=METADATA`.
- **Quota**: 1B units/day, 250/user/sec — unconstrained for one person.
- **Security discipline**:
  - **Never** pair Gmail-read with a free-form `send` tool in the same session. The #1 AI-agent attack pattern is "email tells the agent to forward contents to attacker."
  - Vet the pinned commit of whichever MCP we use; Google-adjacent tooling is a popular supply-chain target.

## 4. GHE (GitHub Enterprise)

- **MCP**: official [`github/github-mcp-server`](https://github.com/github/github-mcp-server) (~29k stars). Two flavors:
  - **GHES on-prem** — **local binary only** (no remote hosting). Set `GITHUB_HOST=https://ghes.example.com` on the binary and give it a fine-grained PAT.
  - **GHE Cloud with data residency** (`*.ghe.com`) — remote endpoint `https://copilot-api.<subdomain>.ghe.com/mcp`.
- **Auth (read-only)**: fine-grained PAT with `metadata:read`, `contents:read`, `pull_requests:read`, `issues:read`, `actions:read`. Scope to specific repos, not account-wide.
- **Hardening flags**: invoke with `--read-only --toolsets repos,issues,pull_requests` to shrink the surface.
- **Gotcha**: classic PATs (not fine-grained) are account-wide. A leaked classic PAT reads every private repo the user can see — never use classic for this integration.

## 5. Neon

- **MCP**: official [`neondatabase/mcp-server-neon`](https://github.com/neondatabase/mcp-server-neon) (~585 stars), also available hosted at `https://mcp.neon.tech/mcp` with OAuth. Hosted + OAuth is the cleanest path.
- **Auth**: OAuth (hosted MCP) or Neon API key (Bearer). Hosted OAuth is preferable — revocable from the Neon dashboard.
- **Vendor warning**: Neon explicitly marks this MCP as **not for production** — it can execute arbitrary SQL/DDL. Gate writes.
- **Recommended shape**:
  - Create a dedicated Postgres role with `GRANT SELECT ON ... TO read_only_role` and pass that role's connection string.
  - Point the agent at **Neon branches**, never main. Branches are cheap, disposable, and reset-friendly.
- **Rate limit**: ~700 req/min per API key.

## 6. Vercel

- **MCP**: official hosted server at `https://mcp.vercel.com/` (launched 2025). OAuth per-team — you authorize a specific team, and the MCP cannot reach other teams' resources.
- **Auth**: Vercel OAuth scoped to the chosen team/project.
- **API fallback**: `GET /v6/deployments?teamId=...&limit=20` with a Vercel access token; token-scope must be team, not account.
- **Not the same thing**: [`vercel/mcp-adapter`](https://github.com/vercel/mcp-adapter) is a library for *building* MCP servers on Next.js — not a Vercel-API MCP. Don't confuse them.
- **Community option** if the hosted MCP is unusable: [`nganiet/mcp-vercel`](https://github.com/nganiet/mcp-vercel) (66 stars, last push Aug 2025, appears stale).

## Cross-cutting security rules

1. **Read scopes until a task provably needs write.** Our whole model assumes the glasses are a monitor+approval surface, not a command-line.
2. **Metadata scopes beat full-read scopes** where the vendor offers them (Gmail is the main case).
3. **Prompt-injection boundaries** — emails and PR descriptions are attacker-controlled text. When they're in context, disable tools that can exfil (send mail, open URLs, post to webhooks) in the same session.
4. **Rotate tokens on loss**, and record rotation runbooks for each integration in this folder as we add them.
5. **Pin MCP versions** — don't follow `latest` on community servers. Record the pinned commit/tag in the OpenClaw config so rollbacks are trivial.

## Gaps / honesty

- **Google (Calendar + Gmail) has no first-party MCP** — we are trusting community code with read access to personal inboxes and calendars. Vet specific commits; read the code.
- **iCalendar has no MCP ecosystem** — we'll own a tiny skill for it.
- **GHES on-prem cannot use a remote MCP** — operational cost: we ship and update the GitHub MCP binary on the OpenClaw VPS ourselves.

## References

- MCP server directory: https://github.com/modelcontextprotocol/servers
- MCP spec: https://modelcontextprotocol.io/
- GitHub MCP: https://github.com/github/github-mcp-server
- Neon MCP: https://github.com/neondatabase/mcp-server-neon
- Vercel MCP docs: https://vercel.com/docs/mcp
