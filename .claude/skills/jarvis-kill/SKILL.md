---
name: jarvis-kill
description: Tear down the complete Even G2 Claude dev environment — tmux+Claude Code, WebSocket relay, Vite dev server, and Even Hub simulator. Use this when the stack is in a weird state and you want a clean slate, or just to stop everything at the end of a dev session. Symmetric counterpart to jarvis-init.
---

# jarvis-kill

Tear down the full Even G2 Claude dev environment. Stops everything `jarvis-init` started.

## Rules

- Execute via the Bash tool.
- Do **not** narrate each kill as you run it. Execute quietly and post a single concise status block at the end.
- Idempotent: safe to run even if nothing is currently running. Missing processes are reported as already-down, not as failures.
- Does **not** delete `/tmp/relay-token` — that's intentionally persistent so the simulator's cached URL hash keeps working across dev sessions. If you want to rotate the token, do it manually.

## Steps

1. **Kill everything in a single Bash call.** Each command suppresses its own errors so a missing target is a no-op.

   ```bash
   tmux kill-session -t claudecode 2>/dev/null
   pkill -f "node server.js" 2>/dev/null
   pkill -f "evenhub-simulator" 2>/dev/null
   pkill -f "vite" 2>/dev/null
   ```

2. **Verify** the teardown completed by checking for any lingering processes and port listeners. A port that's still bound means one of the `pkill`s missed its target (usually because the process was run with a different command line).

   ```bash
   tmux ls 2>&1 | grep claudecode
   lsof -nP -iTCP:3000 -sTCP:LISTEN 2>&1 | tail -n +2
   lsof -nP -iTCP:5173 -sTCP:LISTEN 2>&1 | tail -n +2
   ps aux | grep -E "evenhub-simulator" | grep -v grep
   ```

## Final report

Post a single status block like this:

```
✅ tmux claudecode          (killed)
✅ relay-server             (killed — port 3000 free)
✅ vite dev server          (killed — port 5173 free)
✅ Even Hub simulator       (killed)

Clean slate. Run /jarvis-init to bring everything back up.
```

If a component was already down before the kill, use `(already down)` instead of `(killed)` — the check is just "is the thing running now," not "did we successfully terminate it."

If any port is still bound or any process still alive after step 1, mark that component ❌ with the residual PID / port details underneath so the user can debug.
