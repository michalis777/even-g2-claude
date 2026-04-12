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

const ALLOWED_COMMANDS = new Set(['y', 'n']);

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
let outputBuffer    = [];
let lastSentHash    = null;
let approvalPending = false;
const clients       = new Set();
const authFailures  = new Map();

const APPROVAL_PATTERNS = [
  /Do you want to proceed\?/i,
  /Allow this action\?/i,
  /\[y\/n\]/i,
  /\(y\/N\)/i,
  /Press Enter to continue/i,
  /Approve|Reject/i,
];

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

function detectApproval(lines) {
  return APPROVAL_PATTERNS.some(p => p.test(lines.slice(-5).join('\n')));
}

function simpleHash(lines) {
  return lines.slice(-20).join('|');
}

function sendToTmux(command) {
  if (!ALLOWED_COMMANDS.has(command)) {
    console.warn(`[security] Blocked disallowed command: "${command}"`);
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

// ── Send init payload to a newly authenticated socket ────────────────────────
function sendInit(ws) {
  ws.send(JSON.stringify({
    type:            'init',
    lines:           outputBuffer,
    approvalPending,
    chunkSize:       CONFIG.chunkSize,
    timestamp:       Date.now(),
  }));
}

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === 1 && client.authenticated) client.send(json);
  }
}

function broadcastBuffer() {
  broadcast({ type: 'output', lines: outputBuffer, approvalPending, timestamp: Date.now() });
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
    lastSentHash    = hash;
    outputBuffer    = lines.slice(-CONFIG.maxLines);
    approvalPending = detectApproval(outputBuffer);
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
      case 'approve': sendToTmux('y'); break;
      case 'reject':  sendToTmux('n'); break;
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
    approvalPending = detectApproval(outputBuffer);
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
║  commands: whitelist only (y, n)         ║
╚══════════════════════════════════════════╝
${ipNote}
`);
