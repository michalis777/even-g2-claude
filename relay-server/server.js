/**
 * Claude Code Glasses Relay Server — Session Auth Edition
 *
 * Auth flow:
 *   First connect:   { type: 'auth', token: RELAY_TOKEN }
 *                 ←  { type: 'session', sessionToken: '<uuid>', expiresAt: <ms> }
 *                 ←  { type: 'init', lines: [...], ... }
 *
 *   Reconnects:      { type: 'resume', sessionToken: '<uuid>' }
 *                 ←  { type: 'init', lines: [...], ... }   ← no prompt, straight to data
 *
 *   Session expiry:  { type: 'session_expired' }
 *                 ←  plugin falls back to full auth automatically
 *
 * Security model:
 *   - Master RELAY_TOKEN never leaves the server after initial auth
 *   - Session tokens are random UUIDs, stored in server memory only
 *   - Sessions expire after SESSION_TTL_MS (default 30 days)
 *   - Server restart invalidates all sessions (plugin re-auths once automatically)
 *   - IP allowlist, auth rate limiting, command whitelist all still apply
 *   - wss:// / Tailscale still required for non-localhost
 */

'use strict';

const { WebSocketServer } = require('ws');
const { execSync }        = require('child_process');
const readline            = require('readline');
const crypto              = require('crypto');
const fs                  = require('fs');

// ── Unified debug log ────────────────────────────────────────────────────────
// Append-only sink shared with the glasses-plugin (via ws 'log' messages) and
// the jarvis-init skill (which tees vite/sim stdout here). Inspect via the
// jarvis-debug skill instead of opening the simulator's DevTools.
const DEBUG_LOG_PATH = '/tmp/jarvis-debug.log';

function appendDebugLog(source, level, message) {
  try {
    const iso = new Date().toISOString();
    const lvl = String(level || 'log').toUpperCase();
    const line = `${iso} [${source}] ${lvl} ${message}\n`;
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch {
    // Swallow — debug logging must never break the relay.
  }
}

// Wrap console.* once so every existing relay log line mirrors to the file
// tagged [relay]. Original stdout behaviour is preserved for the tmux pane.
(function wrapConsole() {
  const origLog   = console.log.bind(console);
  const origWarn  = console.warn.bind(console);
  const origError = console.error.bind(console);
  const fmt = (args) => args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error)    return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  console.log   = (...a) => { origLog(...a);   appendDebugLog('relay', 'log',   fmt(a)); };
  console.warn  = (...a) => { origWarn(...a);  appendDebugLog('relay', 'warn',  fmt(a)); };
  console.error = (...a) => { origError(...a); appendDebugLog('relay', 'error', fmt(a)); };
})();

// ── Token enforcement ─────────────────────────────────────────────────────────
const RELAY_TOKEN = process.env.RELAY_TOKEN;
if (!RELAY_TOKEN || RELAY_TOKEN.length < 32) {
  console.error(`
ERROR: RELAY_TOKEN is not set or too short (minimum 32 characters).

Generate one:
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

Then: export RELAY_TOKEN=<your token>
`);
  process.exit(1);
}

const ALLOWED_IPS = process.env.ALLOWED_IPS
  ? new Set(process.env.ALLOWED_IPS.split(',').map(s => s.trim()))
  : null;

const CONFIG = {
  port:             process.env.PORT || 3000,
  tmuxSession:      process.argv.includes('--tmux-session')
                      ? process.argv[process.argv.indexOf('--tmux-session') + 1]
                      : 'claudecode',
  tmuxWindow:       process.argv.includes('--tmux-window')
                      ? process.argv[process.argv.indexOf('--tmux-window') + 1]
                      : '0',
  pollIntervalMs:   500,
  maxLines:         200,
  chunkSize:        8,
  authTimeoutMs:    5000,
  maxAuthAttempts:  3,
  sessionTtlMs:     30 * 24 * 60 * 60 * 1000, // 30 days
};

// Command whitelist is now prompt-state-gated — see isCommandAllowed() below.
// Base whitelist: y/n plus digits 1-9 (for numbered choice prompts).
const BASE_ALLOWED_COMMANDS = new Set([
  'y', 'n',
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
]);

// ── Session store (memory only — cleared on server restart) ───────────────────
// Map of sessionToken -> { createdAt, lastSeenAt, ip }
const sessions = new Map();

function createSession(ip) {
  const sessionToken = crypto.randomUUID();
  sessions.set(sessionToken, {
    createdAt:  Date.now(),
    lastSeenAt: Date.now(),
    ip,
  });
  return sessionToken;
}

function validateSession(sessionToken, ip) {
  const session = sessions.get(sessionToken);
  if (!session) return false;
  if (Date.now() - session.createdAt > CONFIG.sessionTtlMs) {
    sessions.delete(sessionToken);
    return false;
  }
  session.lastSeenAt = Date.now();
  return true;
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > CONFIG.sessionTtlMs) {
      sessions.delete(token);
    }
  }
}
setInterval(pruneExpiredSessions, 60 * 60 * 1000);

// ── State ─────────────────────────────────────────────────────────────────────
let outputBuffer   = [];
let lastSentHash   = null;
// Structured prompt state replaces the old approvalPending boolean.
// Shape: { kind: 'choice', options: string[], selectedIndex: number }
//      | { kind: 'yn' }
//      | null
let currentPrompt  = null;
const clients      = new Set();
const authFailures = new Map();

// Legacy y/n fallback patterns. Modern Claude Code uses the numbered-choice
// widget for everything, so these are unlikely to fire against real output —
// retained as a defense against older Claude Code builds and other CLI tools.
const YN_PATTERNS = [
  /\[y\/n\]/i,
  /\(y\/N\)/i,
  /\(Y\/n\)/i,
  /Press Enter to continue/i,
];

// Choice prompt parser anchors. See relay-server/samples/choice.txt for the
// canonical format.
const CHOICE_FOOTER_RE = /Esc to cancel/;
const CHOICE_OPTION_RE = /^\s*(❯\s*)?(\d+)\.\s+(.+?)\s*$/;

// ── Helpers ───────────────────────────────────────────────────────────────────
function tokenValid(candidate) {
  if (typeof candidate !== 'string') return false;
  if (candidate.length !== RELAY_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(candidate, 'utf8'),
      Buffer.from(RELAY_TOKEN, 'utf8')
    );
  } catch { return false; }
}

function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim()
      || req.socket.remoteAddress
      || 'unknown';
}

function ipAllowed(ip) {
  return !ALLOWED_IPS || ALLOWED_IPS.has(ip);
}

function recordAuthFailure(ip) {
  const count = (authFailures.get(ip) || 0) + 1;
  authFailures.set(ip, count);
  return count;
}

function captureTmux() {
  try {
    const target = `${CONFIG.tmuxSession}:${CONFIG.tmuxWindow}`;
    const raw = execSync(
      `tmux capture-pane -pt "${target}" -S -${CONFIG.maxLines}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return raw.split('\n');
  } catch { return null; }
}

// Scan the tail of the buffer for an active Claude Code confirmation widget.
// Returns a structured Prompt object or null. Anchors on the footer
// "Esc to cancel" line and walks upward collecting consecutive "N. text"
// option lines; the ❯ marker identifies the currently-highlighted option.
function detectPrompt(lines) {
  const tail = lines.slice(-20);

  let footerIdx = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (CHOICE_FOOTER_RE.test(tail[i])) { footerIdx = i; break; }
  }

  if (footerIdx !== -1) {
    // Walk upward from the footer, collecting every non-blank line into a raw
    // buffer until we hit a blank (which separates the widget from prior
    // output). Leading blanks between footer and first option are skipped.
    const raw = [];
    for (let i = footerIdx - 1; i >= 0; i--) {
      const line = tail[i];
      if (!line || !line.trim()) {
        if (raw.length === 0) continue;
        break;
      }
      raw.push(line);
    }
    raw.reverse(); // now top-down: [question?, opt1, opt1-cont?, opt2, ...]

    // Parse top-down. A line that matches CHOICE_OPTION_RE starts a new
    // option; a non-matching line either extends the previous option (Claude
    // Code wraps long option text onto indented continuation rows at narrow
    // tmux widths) or, if no option has been seen yet, is the question line.
    const rows = [];
    let question = null;
    for (const line of raw) {
      const m = line.match(CHOICE_OPTION_RE);
      if (m) {
        const selected = !!m[1];
        const text = m[3].replace(/\s*\(shift\+tab\)\s*$/, '').trim();
        rows.push({ text, selected });
      } else if (rows.length > 0) {
        rows[rows.length - 1].text += ' ' + line.trim();
      } else if (question === null) {
        question = line.trim();
      }
    }

    if (rows.length >= 2) {
      const selectedIdx = rows.findIndex(r => r.selected);
      return {
        kind: 'choice',
        question,
        options: rows.map(r => r.text),
        selectedIndex: selectedIdx === -1 ? 0 : selectedIdx,
      };
    }
  }

  // Legacy y/n fallback
  if (YN_PATTERNS.some(p => p.test(tail.slice(-5).join('\n')))) {
    return { kind: 'yn' };
  }

  return null;
}

function simpleHash(lines) {
  return lines.slice(-20).join('|');
}

// Gate commands by the currently-active prompt. Even if the WebSocket is
// compromised, the attacker can only send the specific selection the relay
// itself has already parsed as valid.
function isCommandAllowed(command, prompt) {
  if (!BASE_ALLOWED_COMMANDS.has(command)) return false;

  if (prompt?.kind === 'yn') {
    return command === 'y' || command === 'n';
  }

  if (prompt?.kind === 'choice') {
    const idx = parseInt(command, 10);
    return Number.isInteger(idx) && idx >= 1 && idx <= prompt.options.length;
  }

  // No active prompt → nothing is allowed
  return false;
}

function sendToTmux(command, prompt) {
  if (!isCommandAllowed(command, prompt)) {
    console.warn(
      `[security] Blocked command "${command}" under prompt=${prompt?.kind ?? 'none'}`
    );
    return false;
  }
  try {
    const target = `${CONFIG.tmuxSession}:${CONFIG.tmuxWindow}`;
    execSync(`tmux send-keys -t "${target}" "${command}" Enter`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`[tmux →] ${command}`);
    return true;
  } catch (e) {
    console.error('Failed to send to tmux:', e.message);
    return false;
  }
}

// Named keys reachable via `tmux send-keys`. Locked down to arrow-nav + Enter
// because that's all Claude Code's confirmation widget needs. The plugin
// cannot request arbitrary named keys — only the relay's own choice handler
// constructs sequences from this set.
const ALLOWED_KEYS = new Set(['Up', 'Down', 'Enter']);

function sendKeysToTmux(keys) {
  for (const k of keys) {
    if (!ALLOWED_KEYS.has(k)) {
      console.warn(`[security] Blocked key "${k}"`);
      return false;
    }
  }
  try {
    const target = `${CONFIG.tmuxSession}:${CONFIG.tmuxWindow}`;
    execSync(`tmux send-keys -t "${target}" ${keys.join(' ')}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`[tmux →] ${keys.join(' ')}`);
    return true;
  } catch (e) {
    console.error('Failed to send keys to tmux:', e.message);
    return false;
  }
}

// For a 'choice' selection: compute the keystroke sequence that moves the
// Claude Code cursor from its current position (parsed from the ❯ marker)
// to the user's picked index, then presses Enter.
function resolveChoice(targetIdx1Based, prompt) {
  if (!prompt || prompt.kind !== 'choice') {
    console.warn(`[security] resolveChoice with no active choice prompt`);
    return false;
  }
  const total = prompt.options.length;
  if (!Number.isInteger(targetIdx1Based) || targetIdx1Based < 1 || targetIdx1Based > total) {
    console.warn(`[security] resolveChoice out-of-range index=${targetIdx1Based} total=${total}`);
    return false;
  }
  const targetIdx = targetIdx1Based - 1;
  const delta     = targetIdx - prompt.selectedIndex;
  const keys      = [];
  if (delta > 0) for (let i = 0; i < delta;  i++) keys.push('Down');
  if (delta < 0) for (let i = 0; i < -delta; i++) keys.push('Up');
  keys.push('Enter');
  return sendKeysToTmux(keys);
}

// ── Send init payload to a newly authenticated socket ────────────────────────
function sendInit(ws) {
  ws.send(JSON.stringify({
    type:      'init',
    lines:     outputBuffer,
    prompt:    currentPrompt,
    chunkSize: CONFIG.chunkSize,
    timestamp: Date.now(),
  }));
}

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === 1 && client.authenticated) client.send(json);
  }
}

function broadcastBuffer() {
  broadcast({
    type:      'output',
    lines:     outputBuffer,
    prompt:    currentPrompt,
    timestamp: Date.now(),
  });
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  setInterval(() => {
    let hasAuth = false;
    for (const c of clients) { if (c.authenticated) { hasAuth = true; break; } }
    if (!hasAuth) return;

    const lines = captureTmux();
    if (!lines) return;
    const hash = simpleHash(lines);
    if (hash === lastSentHash) return;
    lastSentHash  = hash;
    outputBuffer  = lines.slice(-CONFIG.maxLines);
    currentPrompt = detectPrompt(outputBuffer);
    broadcastBuffer();
  }, CONFIG.pollIntervalMs);
}

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: CONFIG.port });

wss.on('connection', (ws, req) => {
  const ip = getIp(req);

  if (!ipAllowed(ip)) {
    console.warn(`[security] Rejected non-allowlisted IP: ${ip}`);
    ws.terminate();
    return;
  }

  if ((authFailures.get(ip) || 0) >= CONFIG.maxAuthAttempts) {
    console.warn(`[security] Banned IP: ${ip}`);
    ws.terminate();
    return;
  }

  console.log(`[+] Connection from ${ip}`);
  ws.authenticated = false;
  clients.add(ws);

  const authTimeout = setTimeout(() => {
    if (!ws.authenticated) {
      console.warn(`[security] Auth timeout — terminating ${ip}`);
      ws.terminate();
    }
  }, CONFIG.authTimeoutMs);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // ── Plugin debug logs (allowed pre-auth so we can debug auth failures) ──
    // Rate-limited per client to ~50 msg/sec; excess silently dropped.
    if (msg.type === 'log') {
      const now = Date.now();
      if (!ws._logWindowStart || now - ws._logWindowStart > 1000) {
        ws._logWindowStart = now;
        ws._logCount = 0;
      }
      if (ws._logCount++ < 50) {
        const level = ['log', 'warn', 'error'].includes(msg.level) ? msg.level : 'log';
        let text = typeof msg.message === 'string' ? msg.message : '';
        if (text.length > 2048) text = text.slice(0, 2048) + '…';
        if (text) appendDebugLog('plugin', level, text);
      }
      return;
    }

    // ── Not yet authenticated ────────────────────────────────────────────────
    if (!ws.authenticated) {

      // Path A: Full auth with master token (first-ever connect)
      if (msg.type === 'auth') {
        if (tokenValid(msg.token)) {
          ws.authenticated = true;
          clearTimeout(authTimeout);
          const sessionToken = createSession(ip);
          console.log(`[auth] Full auth: ${ip} — session created`);
          ws.send(JSON.stringify({
            type:        'session',
            sessionToken,
            expiresAt:   Date.now() + CONFIG.sessionTtlMs,
          }));
          sendInit(ws);
        } else {
          const failures = recordAuthFailure(ip);
          console.warn(`[security] Bad token from ${ip} (${failures}/${CONFIG.maxAuthAttempts})`);
          ws.send(JSON.stringify({ type: 'auth_fail', remaining: CONFIG.maxAuthAttempts - failures }));
          if (failures >= CONFIG.maxAuthAttempts) ws.terminate();
        }
        return;
      }

      // Path B: Resume with existing session token (reconnects)
      if (msg.type === 'resume') {
        if (typeof msg.sessionToken === 'string' && validateSession(msg.sessionToken, ip)) {
          ws.authenticated = true;
          clearTimeout(authTimeout);
          console.log(`[auth] Session resume: ${ip}`);
          sendInit(ws);
        } else {
          console.log(`[auth] Session invalid/expired: ${ip} — requesting full auth`);
          ws.send(JSON.stringify({ type: 'session_expired' }));
          clearTimeout(authTimeout);
          setTimeout(() => {
            if (!ws.authenticated) {
              console.warn(`[security] No full auth after session expiry — terminating ${ip}`);
              ws.terminate();
            }
          }, CONFIG.authTimeoutMs);
        }
        return;
      }

      // Anything else before auth = terminate
      console.warn(`[security] Pre-auth message "${msg.type}" from ${ip} — terminating`);
      ws.terminate();
      return;
    }

    // ── Authenticated ────────────────────────────────────────────────────────
    switch (msg.type) {
      case 'approve':
        // Legacy shortcut: approve = option 1 on a choice prompt, or 'y'
        // on a legacy y/n prompt.
        if (currentPrompt?.kind === 'yn') {
          sendToTmux('y', currentPrompt);
        } else if (currentPrompt?.kind === 'choice') {
          resolveChoice(1, currentPrompt);
        } else {
          console.warn(`[security] 'approve' with no active prompt from ${ip}`);
        }
        break;

      case 'reject':
        // Legacy shortcut: reject = last option (conventionally "No" / cancel)
        // on a choice prompt, or 'n' on a legacy y/n prompt.
        if (currentPrompt?.kind === 'yn') {
          sendToTmux('n', currentPrompt);
        } else if (currentPrompt?.kind === 'choice') {
          resolveChoice(currentPrompt.options.length, currentPrompt);
        } else {
          console.warn(`[security] 'reject' with no active prompt from ${ip}`);
        }
        break;

      case 'choice': {
        const idx = Number(msg.index);
        if (!Number.isInteger(idx)) {
          console.warn(`[security] 'choice' with non-integer index from ${ip}`);
          break;
        }
        resolveChoice(idx, currentPrompt);
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;

      default:
        console.warn(`[security] Unknown type "${msg.type}" from ${ip}`);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    clients.delete(ws);
    console.log(`[-] Disconnected: ${ip}`);
  });

  ws.on('error', (e) => {
    console.error(`[ws] ${ip}:`, e.message);
    clients.delete(ws);
  });
});

// ── Stdin mock ────────────────────────────────────────────────────────────────
if (process.argv.includes('--stdin-mock')) {
  console.log('[mock] Reading from stdin — type lines to simulate terminal output');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    outputBuffer.push(line);
    if (outputBuffer.length > CONFIG.maxLines) outputBuffer.shift();
    currentPrompt = detectPrompt(outputBuffer);
    broadcastBuffer();
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
startPolling();

const ipNote = ALLOWED_IPS
  ? `  allowed IPs:   ${[...ALLOWED_IPS].join(', ')}`
  : '  IP allowlist:  disabled  (set ALLOWED_IPS=x.x.x.x to restrict)';

console.log(`
╔══════════════════════════════════════════╗
║   Claude Code Glasses Relay — v2         ║
║   ws://localhost:${CONFIG.port}                    ║
╠══════════════════════════════════════════╣
║  tmux:     ${(CONFIG.tmuxSession + ':' + CONFIG.tmuxWindow).padEnd(30)}║
║  auth:     token → session (${Math.round(CONFIG.sessionTtlMs / 86400000)}d TTL)   ║
║  commands: prompt-gated (y/n + 1-9)      ║
╚══════════════════════════════════════════╝
${ipNote}
`);
