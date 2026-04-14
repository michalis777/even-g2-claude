---
name: jarvis-debug
description: Inspect /tmp/jarvis-debug.log — the unified log stream from the Even G2 Claude dev stack (relay, plugin, vite, simulator). Use this instead of opening the simulator's DevTools when troubleshooting scroll/click/auth issues.
---

# jarvis-debug

Surface recent activity from the jarvis stack by reading `/tmp/jarvis-debug.log`. This file is written by:

- **[relay]**   — every `console.log/warn/error` from `relay-server/server.js` (wrapped at startup)
- **[plugin]**  — forwarded from the glasses-plugin via a WebSocket `log` message (the plugin installs a `console.*` shim in `main()` before any other work, so logs start streaming even before auth)
- **[vite]**    — dev-server stdout, tagged by the jarvis-init tee pipeline
- **[sim]**     — evenhub-simulator stdout, same pipeline

`/jarvis-init` truncates the file on each invocation, so its contents describe the **current** dev session.

## Rules

- **Read-only.** Never edit code or configs from this skill — it's a diagnostic tool.
- **Never suggest the user open DevTools.** Browser-console visibility is the whole reason this file exists. If a log line you need isn't present, the fix is to add a `console.log` in the plugin (in a separate turn), not to push the user to DevTools.
- Report a short analysis at the end — don't just dump logs. Call out anomalies like missing auth, missing gesture events, or repeated errors.

## Arguments (optional)

The user may pass a single modifier after `/jarvis-debug`:

- `plugin` / `relay` / `vite` / `sim` → filter to that source
- `errors` → show only WARN/ERROR lines
- `events` → show only `[event]` lines from the plugin (gesture diagnosis)
- `<any other string>` → treat as a ripgrep pattern

No arg = default view (last ~150 lines, unfiltered).

## Steps

1. **Sanity check the file exists.** If `/tmp/jarvis-debug.log` is missing or empty, say so and suggest running `/jarvis-init` — don't fabricate content.

   ```bash
   ls -l /tmp/jarvis-debug.log 2>&1
   wc -l /tmp/jarvis-debug.log 2>&1
   ```

2. **Tail by source.** Use the Grep tool (NOT shell grep) with `output_mode: "content"` and `head_limit: 150` against `/tmp/jarvis-debug.log`:

   - Default: pattern `.` (matches all lines), then use `tail`-style by reading the file with Read + `offset` to skip to the last ~150 lines.
   - `plugin`/`relay`/`vite`/`sim`: pattern `\[<source>\]`
   - `errors`:  pattern `\b(WARN|ERROR)\b`
   - `events`:  pattern `\[plugin\].*\[event\]`
   - raw string: pass through as the pattern

3. **Per-source summary.** In one Bash call, emit counts + last-seen timestamps:

   ```bash
   for src in relay plugin vite sim; do
     count=$(grep -c "\[$src\]" /tmp/jarvis-debug.log 2>/dev/null || echo 0)
     last=$(grep "\[$src\]" /tmp/jarvis-debug.log 2>/dev/null | tail -1 | awk '{print $1}')
     printf '%-8s %5s lines   last: %s\n' "$src" "$count" "${last:-—}"
   done
   ```

4. **Post the report** in this shape:

   ```
   📄 /tmp/jarvis-debug.log   <total> lines

   relay    <n> lines   last: <iso>
   plugin   <n> lines   last: <iso>
   vite     <n> lines   last: <iso>
   sim      <n> lines   last: <iso>

   ─── recent (filtered by <modifier or "none">) ─────────────
   <fenced block of matching lines>
   ─────────────────────────────────────────────────────────

   Observations: <1-3 sentences>
   ```

5. **Observations heuristics.** Before posting, scan what you read:

   - No `[plugin]` lines at all → plugin never connected; check simulator is running and pointing at the right URL.
   - `[plugin]` present but no `[auth] Authenticated` → auth loop failing; look for `auth_fail` or `session_expired`.
   - Gesture troubleshooting (`events` mode):
     - No `[event]` lines → the Even Hub SDK isn't dispatching events to the plugin (simulator or SDK problem).
     - `[event] ... type= undefined` → event shape mismatch in `glasses-plugin/src/main.ts:351` dispatch.
     - `[event]` lines present but no state change visible on glasses → plugin isn't `authenticated`, so the early-return at `main.ts:372` is swallowing them.
   - Repeated `[relay] WARN [security]` → prompt-gated whitelist is rejecting commands; either a real attack or a regression in the prompt parser.

   Pick the one that matches and state it plainly in the Observations block.
