/**
 * Claude Code Glasses Plugin — Session Auth Edition
 *
 * Auth flow:
 *   First connect:
 *     → { type: 'auth', token }
 *     ← { type: 'session', sessionToken, expiresAt }   saved to glasses storage
 *     ← { type: 'init', lines: [...] }
 *
 *   All reconnects (network blip, app restart, phone reboot):
 *     → { type: 'resume', sessionToken }
 *     ← { type: 'init', lines: [...] }                 straight to data, no prompt
 *
 *   If server restarted (session gone):
 *     ← { type: 'session_expired' }
 *     → { type: 'auth', token }                        automatic fallback to full auth
 *     ← { type: 'session', sessionToken, expiresAt }   new session saved
 *
 * The master RELAY_TOKEN is only sent once (full auth). After that, only the
 * session token travels over the wire. Session token lives in Even Hub local
 * storage — survives app restarts and phone reboots until it expires (30 days).
 */

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk';

// ── Config ────────────────────────────────────────────────────────────────────
interface RelayConfig { url: string; token: string; }

function getRelayConfig(): RelayConfig {
  const cfg = (window as any).__RELAY_CONFIG__;
  if (cfg?.url && cfg?.token) return cfg;
  console.warn('[config] window.__RELAY_CONFIG__ not set — using localhost defaults');
  return { url: 'ws://localhost:3000', token: '' };
}

const RELAY_CONFIG = getRelayConfig();

function validateUrl(url: string): string {
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
  if (!isLocal && url.startsWith('ws://')) {
    console.warn('[security] Upgrading ws:// → wss:// for non-localhost URL');
    return url.replace('ws://', 'wss://');
  }
  return url;
}

const RELAY_URL = validateUrl(RELAY_CONFIG.url);

// Even Hub local storage key for the session token
const SESSION_STORAGE_KEY = 'relay_session_token';

// Aggressive layout: single full-display output container + invisible event
// overlay. The status line lives as the first row of output text, and hints
// (when needed) as the last row. Trades the "three-zone" visual structure
// for ~+2 lines of extra terminal content.
const VISIBLE_LINES    = 13;   // terminal content lines between the in-text
                               // status row (top) and optional hints row (bottom)
const LINE_CHAR_LIMIT  = 70;   // per-line char cap
const DISPLAY_WIDTH    = 576;
const DISPLAY_HEIGHT   = 288;

const CONTAINER_OUTPUT = 2;
const CONTAINER_EVENTS = 4;

// ── Types ─────────────────────────────────────────────────────────────────────
// Mirrors the Prompt shape the relay sends. See relay-server/server.js detectPrompt().
type Prompt =
  | { kind: 'yn' }
  | { kind: 'choice'; question: string | null; options: string[]; selectedIndex: number };

// ── State ─────────────────────────────────────────────────────────────────────
let allLines:       string[]      = [];
let scrollOffset                  = 0;  // index of top visible line
let currentPrompt:  Prompt | null = null;
let selectedChoiceIndex           = 0;  // local cursor; seeded from prompt.selectedIndex
// When the user double-taps to dismiss a choice prompt, we stash its key here
// instead of nulling currentPrompt. While this matches promptKey(currentPrompt),
// the renderer treats the active prompt as "hidden" and shows scroll mode; a
// subsequent double-tap un-dismisses it. Any new prompt from the relay (a
// different key) clears the dismissal automatically so we never swallow one.
let dismissedPromptKey: string    = 'none';
let connected                     = false;
let authenticated                 = false;
let ws:             WebSocket | null = null;
let pageCreated                   = false;

type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>;
let bridge: Bridge;

// ── Debug log forwarding ──────────────────────────────────────────────────────
// Wraps console.log/warn/error so every log is *also* forwarded to the relay
// as a {type:'log'} message. The relay appends them to /tmp/jarvis-debug.log,
// which is inspected via the jarvis-debug skill — no DevTools required.
//
// Buffered pre-WS-open so startup logs aren't lost. Flushed in ws.onopen
// BEFORE auth, since the relay accepts 'log' pre-auth (so we can debug auth
// failures themselves). Invariant: do NOT call console.log from hot paths
// (per-poll broadcasts) or this will flood the disk.
type LogLevel = 'log' | 'warn' | 'error';
interface BufferedLog { level: LogLevel; message: string; }
const LOG_BUFFER_CAP = 200;
const logBuffer: BufferedLog[] = [];
let inLogShim = false;

function formatLogArgs(args: unknown[]): string {
  return args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error)    return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

function forwardLog(level: LogLevel, message: string) {
  if (inLogShim) return;
  inLogShim = true;
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'log', level, message }));
    } else {
      if (logBuffer.length >= LOG_BUFFER_CAP) logBuffer.shift();
      logBuffer.push({ level, message });
    }
  } catch {
    // Never let logging errors propagate.
  } finally {
    inLogShim = false;
  }
}

function installConsoleShim() {
  const orig = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
  };
  console.log   = (...a: unknown[]) => { orig.log(...a);   forwardLog('log',   formatLogArgs(a)); };
  console.warn  = (...a: unknown[]) => { orig.warn(...a);  forwardLog('warn',  formatLogArgs(a)); };
  console.error = (...a: unknown[]) => { orig.error(...a); forwardLog('error', formatLogArgs(a)); };
}

function flushLogBuffer() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (logBuffer.length > 0) {
    const entry = logBuffer.shift()!;
    try { ws.send(JSON.stringify({ type: 'log', level: entry.level, message: entry.message })); }
    catch { break; }
  }
}

// ── Session storage helpers ───────────────────────────────────────────────────
async function saveSession(sessionToken: string, expiresAt: number) {
  try {
    await bridge.setLocalStorage(
      SESSION_STORAGE_KEY,
      JSON.stringify({ sessionToken, expiresAt })
    );
    console.log('[session] Saved to local storage');
  } catch (e) {
    console.warn('[session] Failed to save session token:', e);
  }
}

async function loadSession(): Promise<string | null> {
  try {
    const raw = await bridge.getLocalStorage(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const { sessionToken, expiresAt } = JSON.parse(raw);
    if (Date.now() > expiresAt) {
      console.log('[session] Token expired locally — will do full auth');
      await bridge.setLocalStorage(SESSION_STORAGE_KEY, '');
      return null;
    }
    return sessionToken;
  } catch {
    return null;
  }
}

async function clearSession() {
  try { await bridge.setLocalStorage(SESSION_STORAGE_KEY, ''); } catch {}
}

// ── Display ───────────────────────────────────────────────────────────────────
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');
}

// Word-wrap a single logical line to `width` characters. Breaks on the last
// space at or before `width`; if no space fits (single long token), falls back
// to a hard mid-word break so no character is ever lost.
function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let breakAt = rest.lastIndexOf(' ', width);
    if (breakAt <= 0) breakAt = width; // no space → hard wrap
    out.push(rest.slice(0, breakAt).trimEnd());
    rest = rest.slice(breakAt).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

// Flatten `allLines` into the display-line buffer we actually scroll over.
// Each raw tmux line is stripped of ANSI codes and word-wrapped to
// LINE_CHAR_LIMIT, so one long terminal line may emit several display lines.
// This is recomputed per render — allLines is bounded by the relay's
// maxLines, so the cost is negligible.
function computeDisplayLines(): string[] {
  const out: string[] = [];
  for (const line of allLines) {
    out.push(...wrapLine(stripAnsi(line), LINE_CHAR_LIMIT));
  }
  return out;
}

function maxOffset(): number {
  return Math.max(0, computeDisplayLines().length - VISIBLE_LINES);
}

function visibleLines(offset: number): string[] {
  return computeDisplayLines().slice(offset, offset + VISIBLE_LINES);
}

function clampOffset(o: number): number {
  return Math.max(0, Math.min(o, maxOffset()));
}

// Identity key for a Prompt, used to detect "same prompt" across polls so we
// don't clobber the user's local cursor selection every 500ms when the server
// re-broadcasts the same prompt.
function promptKey(p: Prompt | null): string {
  if (!p) return 'none';
  if (p.kind === 'yn') return 'yn';
  return `choice:${p.options.join('|')}`;
}

async function renderDisplay() {
  const lines      = visibleLines(scrollOffset);
  const topLine    = allLines.length === 0 ? 0 : scrollOffset + 1;
  const bottomLine = Math.min(allLines.length, scrollOffset + VISIBLE_LINES);
  const isLatest   = scrollOffset >= maxOffset();
  const hasChoice  = currentPrompt?.kind === 'choice';
  const isDismissed = hasChoice && promptKey(currentPrompt) === dismissedPromptKey;
  const inChoice   = hasChoice && !isDismissed;

  // ── Status row (first line of the single output container) ──────────────
  let statusText: string;
  if (!connected)          statusText = '○ CONNECTING...';
  else if (!authenticated) statusText = '○ AUTH FAILED';
  else if (inChoice) {
    const p = currentPrompt as Extract<Prompt, { kind: 'choice' }>;
    statusText = `● CHOOSE  ${selectedChoiceIndex + 1}/${p.options.length}`;
  }
  else if (currentPrompt?.kind === 'yn') statusText = `● LIVE  !! APPROVE  ${topLine}-${bottomLine}/${allLines.length}`;
  else                                   statusText = `● LIVE  ${topLine}-${bottomLine}/${allLines.length}`;

  // ── Hints row (last line, only shown when actionable) ───────────────────
  let hintsText = '';
  if (!authenticated)                    hintsText = '';
  else if (inChoice)                     hintsText = '[▲▼]=select  [tap]=confirm  [dbl]=hide';
  else if (isDismissed)                  hintsText = '[dbl]=show choice  [▲▼]=scroll';
  else if (currentPrompt?.kind === 'yn') hintsText = '[tap]=YES  [dbl]=NO  [▲▼]=scroll';
  // scroll mode: no hints — reclaim the line for content.

  // ── Content body ─────────────────────────────────────────────────────────
  let bodyText: string;
  if (!connected) {
    bodyText = `Connecting...\n${RELAY_URL}`;
  } else if (!authenticated) {
    bodyText = 'Auth failed.\n\nCheck RELAY_TOKEN matches\nthe server.';
  } else if (inChoice) {
    const p = currentPrompt as Extract<Prompt, { kind: 'choice' }>;
    const out: string[] = [];
    if (p.question) out.push(...wrapLine(p.question, LINE_CHAR_LIMIT));
    p.options.forEach((opt, i) => {
      const marker = i === selectedChoiceIndex ? '▶' : ' ';
      const prefix = `${marker} ${i + 1}. `;
      const wrapped = wrapLine(opt, LINE_CHAR_LIMIT - prefix.length);
      out.push(prefix + wrapped[0]);
      for (let j = 1; j < wrapped.length; j++) {
        out.push(' '.repeat(prefix.length) + wrapped[j]);
      }
    });
    bodyText = out.join('\n');
  } else {
    bodyText = lines.join('\n') || '(no output)';
  }

  // ── Compose single-container text: status + body + optional hints ───────
  // The simulator (and real firmware) caps TextContainerUpgrade content at
  // 999 BYTES, not chars. `VISIBLE_LINES × LINE_CHAR_LIMIT` is a char budget,
  // and Unicode in Claude's output (box-drawing ╌, bullets ⏺, markers ❯) is
  // 3 bytes each — so a full 13-line buffer routinely composes to 1100-1400
  // bytes and the upgrade gets rejected, freezing the display on the last
  // successful render. Trim from the top of the body (oldest visible line)
  // until the whole composed text fits, leaving ~50 bytes of headroom.
  const BYTE_BUDGET = 950;
  const byteLen = (s: string) => new TextEncoder().encode(s).length;
  const compose = (body: string) =>
    [statusText, body, hintsText].filter(s => s.length > 0).join('\n');

  let bodyLines = bodyText.split('\n');
  let outputText = compose(bodyLines.join('\n'));
  while (byteLen(outputText) > BYTE_BUDGET && bodyLines.length > 1) {
    bodyLines.shift();
    outputText = compose(bodyLines.join('\n'));
  }

  const outputContainer = new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT,
    borderWidth: 0, borderColor: 5, paddingLength: 0,
    containerID: CONTAINER_OUTPUT, containerName: 'output',
    content: outputText,
    isEventCapture: 0,
  });

  // Invisible full-display overlay that captures input events without
  // interfering with firmware scroll (which would swallow our scroll events)
  const eventsContainer = new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT,
    borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: CONTAINER_EVENTS, containerName: 'events',
    content: ' ',
    isEventCapture: 1,
  });

  if (!pageCreated) {
    const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 2,
      textObject: [outputContainer, eventsContainer],
    }));
    console.log('[display] createStartUpPageContainer result:', result);
    pageCreated = true;
  } else {
    await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: CONTAINER_OUTPUT, containerName: 'output',
      content: outputText, contentOffset: 0, contentLength: outputText.length,
    }));
  }
}

// ── WebSocket + session auth ──────────────────────────────────────────────────
async function connectRelay(url: string) {
  console.log(`[relay] Connecting to ${url}`);
  ws = new WebSocket(url);

  ws.onopen = async () => {
    connected = true;
    authenticated = false;

    // Flush any logs buffered before the socket opened. Relay accepts 'log'
    // pre-auth, so this runs before the auth/resume handshake below.
    flushLogBuffer();

    // Try to resume with saved session first
    const savedToken = await loadSession();
    if (savedToken) {
      console.log('[auth] Attempting session resume...');
      ws!.send(JSON.stringify({ type: 'resume', sessionToken: savedToken }));
    } else {
      console.log('[auth] No saved session — full auth');
      ws!.send(JSON.stringify({ type: 'auth', token: RELAY_CONFIG.token }));
    }

    renderDisplay();
  };

  ws.onmessage = async (event) => {
    let msg: any;
    try { msg = JSON.parse(event.data as string); } catch { return; }

    switch (msg.type) {

      // Server issued a new session token after full auth
      case 'session': {
        console.log('[auth] Session token received — saving');
        await saveSession(msg.sessionToken, msg.expiresAt);
        break;
      }

      // Session token was invalid/expired — clear local copy and re-auth
      case 'session_expired': {
        console.log('[auth] Session expired on server — doing full auth');
        await clearSession();
        ws!.send(JSON.stringify({ type: 'auth', token: RELAY_CONFIG.token }));
        break;
      }

      case 'auth_fail': {
        console.error(`[auth] Full auth failed — ${msg.remaining} attempts left`);
        authenticated = false;
        renderDisplay();
        break;
      }

      // init arrives right after auth or resume — this means we're in
      case 'init':
      case 'output': {
        if (!authenticated) {
          authenticated = true;
          console.log('[auth] Authenticated');
        }

        const wasLatest = scrollOffset >= maxOffset();
        const prevPromptKey = promptKey(currentPrompt);
        allLines = (msg.lines as string[]).filter(l => l.trim().length > 0);
        currentPrompt = (msg.prompt ?? null) as Prompt | null;

        // Seed the local cursor from the server's parsed selection whenever
        // a new choice prompt appears (new prompt, or options changed).
        const newPromptKey = promptKey(currentPrompt);
        if (currentPrompt?.kind === 'choice' && newPromptKey !== prevPromptKey) {
          selectedChoiceIndex = currentPrompt.selectedIndex;
        }

        // A user-dismissed prompt stays dismissed only while the same prompt
        // key is still active on the server. Any change — prompt resolved
        // (→ 'none') or a different prompt replacing it — clears the flag so
        // we don't accidentally swallow a fresh prompt.
        if (newPromptKey !== dismissedPromptKey) {
          dismissedPromptKey = 'none';
        }

        if (wasLatest || msg.type === 'init') {
          scrollOffset = maxOffset();
        } else {
          scrollOffset = clampOffset(scrollOffset);
        }

        renderDisplay();
        break;
      }

      case 'pong': break;

      default:
        console.warn('[relay] Unknown message:', msg.type);
    }
  };

  ws.onclose = () => {
    console.log('[relay] Disconnected — retrying in 3s');
    connected = authenticated = false;
    renderDisplay();
    setTimeout(() => connectRelay(url), 3000);
  };

  ws.onerror = (e) => console.error('[relay] WS error', e);
}

function sendToRelay(msg: object) {
  if (ws && ws.readyState === WebSocket.OPEN && authenticated) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Input ─────────────────────────────────────────────────────────────────────
function setupInput() {
  bridge.onEvenHubEvent((event) => {
    // ── Event dispatch ──
    // The SDK has 4 typed paths (listEvent / textEvent / sysEvent / audioEvent)
    // plus a raw jsonData fallback for hosts that don't use the typed PB model.
    // CLICK_EVENT has enum value 0, which protobuf strips as a default — so when
    // eventType is missing on any of these paths we assume CLICK_EVENT.
    const anyEvent = event as any;
    const rawJson  = anyEvent.jsonData;
    let   type:      OsEventTypeList | undefined;
    let   source:    string = 'none';

    if (event.listEvent) {
      type   = event.listEvent.eventType ?? OsEventTypeList.CLICK_EVENT;
      source = 'listEvent';
    } else if (event.textEvent) {
      type   = event.textEvent.eventType ?? OsEventTypeList.CLICK_EVENT;
      source = 'textEvent';
    } else if (event.sysEvent) {
      type   = event.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT;
      source = 'sysEvent';
    } else if (rawJson && typeof rawJson === 'object') {
      // Host sent a raw dict — look for an eventType-ish field
      const rawType = rawJson.eventType ?? rawJson.event_type ?? rawJson.Event_Type;
      if (rawType !== undefined) {
        type   = typeof rawType === 'number' ? rawType : OsEventTypeList.CLICK_EVENT;
        source = 'jsonData';
      }
    }

    console.log('[event]', source, 'type=', type);

    if (type === undefined || type === null) return;
    if (!authenticated) return;

    // Local inChoice mirrors the renderer: an active-but-dismissed prompt
    // behaves like scroll mode until the user double-taps to un-dismiss it.
    const hasChoice = currentPrompt?.kind === 'choice';
    const isDismissed = hasChoice && promptKey(currentPrompt) === dismissedPromptKey;
    const inChoice = hasChoice && !isDismissed;

    switch (type) {
      case OsEventTypeList.SCROLL_TOP_EVENT:
        if (inChoice) {
          selectedChoiceIndex = Math.max(0, selectedChoiceIndex - 1);
        } else {
          scrollOffset = clampOffset(scrollOffset - 1);
        }
        renderDisplay();
        break;

      case OsEventTypeList.SCROLL_BOTTOM_EVENT:
        if (inChoice) {
          const p = currentPrompt as Extract<Prompt, { kind: 'choice' }>;
          selectedChoiceIndex = Math.min(p.options.length - 1, selectedChoiceIndex + 1);
        } else {
          scrollOffset = clampOffset(scrollOffset + 1);
        }
        renderDisplay();
        break;

      case OsEventTypeList.CLICK_EVENT:
        if (inChoice) {
          sendToRelay({ type: 'choice', index: selectedChoiceIndex + 1 });
          // Don't clear locally — wait for the server's next broadcast to
          // show the prompt has been resolved (outputBuffer will no longer
          // contain the widget).
        } else if (currentPrompt?.kind === 'yn') {
          sendToRelay({ type: 'approve' });
        }
        break;

      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        if (inChoice) {
          // Dismiss the choice UI locally so the user can scroll terminal
          // context. The server still has the prompt active; re-show it with
          // another double-tap from scroll mode.
          dismissedPromptKey = promptKey(currentPrompt);
          scrollOffset = maxOffset();
        } else if (isDismissed) {
          // Un-dismiss: bring the choice UI back and reseed the cursor.
          dismissedPromptKey = 'none';
          if (currentPrompt?.kind === 'choice') {
            selectedChoiceIndex = currentPrompt.selectedIndex;
          }
        } else if (currentPrompt?.kind === 'yn') {
          sendToRelay({ type: 'reject' });
        } else {
          scrollOffset = maxOffset();
        }
        renderDisplay();
        break;
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  installConsoleShim();
  console.log('[plugin] Waiting for Even App Bridge...');
  bridge = await waitForEvenAppBridge();
  console.log('[plugin] Bridge ready');

  allLines = ['Connecting...'];
  await renderDisplay();

  setupInput();
  await connectRelay(RELAY_URL);
}

main().catch(console.error);
