---
name: jarvis-init
description: Spin up the complete Even G2 Claude dev environment in one go — tmux+Claude Code, WebSocket relay, Vite dev server, and Even Hub simulator. Idempotent — kills any stale instances first so you always get a clean slate. Use this at the start of a dev session to interact with the glasses display simulator.
---

# jarvis-init

Bootstrap the full Even G2 Claude dev environment so the user can interact with the glasses display simulator.

## Rules

- Execute every step via the Bash tool. Use `run_in_background: true` for every long-lived process (relay, vite, simulator).
- Do **not** narrate each step as you run it. Execute quietly and post a single concise status block at the end.
- If a step fails, mark it ❌ in the final report and include the relevant error output beneath it. Do not try to fix errors automatically — the user can debug after seeing the report.
- All paths below are absolute to avoid CWD drift between Bash calls.

## Steps

1. **Clean slate.** Kill any stale processes from previous sessions in a single Bash call. Leave Vite alone — restarting it is slow and HMR survives across sessions, so only start it fresh in step 5 if nothing is listening on port 5173.

   ```bash
   tmux kill-session -t claudecode 2>/dev/null
   pkill -f "node server.js" 2>/dev/null
   pkill -f "evenhub-simulator" 2>/dev/null
   ```

2. **Relay token.** Ensure `/tmp/relay-token` exists with ≥32 characters. Generate one only if missing or too short — don't rotate on every invocation because the simulator caches it in its URL hash.

   ```bash
   if [ ! -s /tmp/relay-token ] || [ $(wc -c < /tmp/relay-token) -lt 32 ]; then
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > /tmp/relay-token
   fi
   ```

3. **Tmux + Claude Code.** Create a detached tmux session named `claudecode` and launch `claude` inside it. The user attaches separately. The `sleep 0.5` is deliberate — it gives the freshly-spawned zsh enough time to finish initializing before `send-keys` fires, otherwise the keystrokes can race the shell startup and get lost.

   ```bash
   tmux new-session -d -s claudecode -x 120 -y 30
   sleep 0.5
   tmux send-keys -t claudecode "cd /Users/Mike.Kantartjis/Documents/dikaMou/even-g2-claude && claude" Enter
   ```

4. **Relay server.** Start as a background Bash task using an absolute path so the process is easy to identify later.

   ```bash
   cd /Users/Mike.Kantartjis/Documents/dikaMou/even-g2-claude/relay-server && RELAY_TOKEN=$(cat /tmp/relay-token) node server.js
   ```

   After launching, read the task's output once to confirm the `Claude Code Glasses Relay — v2` banner printed and there's no `EADDRINUSE` error. If port 3000 is still occupied, something in step 1 failed — surface it in the report.

5. **Vite dev server.** First check if vite is already running (`lsof -nP -iTCP:5173 -sTCP:LISTEN`). If yes, skip. If no, start it as a background task:

   ```bash
   cd /Users/Mike.Kantartjis/Documents/dikaMou/even-g2-claude/glasses-plugin && npm run dev
   ```

   Tail the task output once and confirm you see `VITE ... ready in`.

6. **Even Hub simulator.** Start as a background task, passing the token and relay URL as URL hash params so the plugin gets configured on load:

   ```bash
   TOKEN=$(cat /tmp/relay-token); npx -y @evenrealities/evenhub-simulator "http://localhost:5173/#token=$TOKEN&url=ws://localhost:3000"
   ```

7. **Verify.** In one Bash call, confirm the full state:

   ```bash
   tmux ls 2>&1 | grep claudecode
   lsof -nP -iTCP:3000 -sTCP:LISTEN 2>&1 | tail -n +2
   lsof -nP -iTCP:5173 -sTCP:LISTEN 2>&1 | tail -n +2
   ps aux | grep -E "evenhub-simulator" | grep -v grep | awk '{print $2}' | head -1
   ```

## Final report

Post a single status block like this. Keep it short:

```
✅ tmux claudecode          (attach: tmux attach -t claudecode)
✅ relay-server             (ws://localhost:3000, task <bg-id>)
✅ vite dev server          (http://localhost:5173)
✅ Even Hub simulator       (task <bg-id>)

Ready. Drive Claude Code with:  tmux attach -t claudecode
(Detach with Ctrl-b d. The relay polls tmux independently of your attachment.)
```

Mark any failed component with ❌ and put the error underneath, indented. Do not offer to fix — leave that to the user's next message.
