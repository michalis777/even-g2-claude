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

const VISIBLE_LINES    = 8;
const DISPLAY_WIDTH    = 576;

const CONTAINER_STATUS = 1;
const CONTAINER_OUTPUT = 2;
const CONTAINER_HINTS  = 3;
const CONTAINER_EVENTS = 4;

// ── State ─────────────────────────────────────────────────────────────────────
let allLines:       string[]      = [];
let scrollOffset                  = 0;  // index of top visible line
let approvalPending               = false;
let connected                     = false;
let authenticated                 = false;
let ws:             WebSocket | null = null;
let pageCreated                   = false;

type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>;
let bridge: Bridge;

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
function maxOffset(): number {
  return Math.max(0, allLines.length - VISIBLE_LINES);
}

function visibleLines(offset: number): string[] {
  return allLines.slice(offset, offset + VISIBLE_LINES);
}

function clampOffset(o: number): number {
  return Math.max(0, Math.min(o, maxOffset()));
}

function truncate(line: string, maxChars = 58): string {
  return line.length <= maxChars ? line : line.slice(0, maxChars - 1) + '…';
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');
}

async function renderDisplay() {
  const lines      = visibleLines(scrollOffset);
  const topLine    = allLines.length === 0 ? 0 : scrollOffset + 1;
  const bottomLine = Math.min(allLines.length, scrollOffset + VISIBLE_LINES);
  const isLatest   = scrollOffset >= maxOffset();

  let statusText: string;
  if (!connected)       statusText = '○ CONNECTING...';
  else if (!authenticated) statusText = '○ AUTH FAILED';
  else if (approvalPending) statusText = `● LIVE  !! APPROVE  ${topLine}-${bottomLine}/${allLines.length}`;
  else                  statusText = `● LIVE  ${topLine}-${bottomLine}/${allLines.length}`;

  const statusContainer = new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: DISPLAY_WIDTH, height: 32,
    borderWidth: 1,
    borderColor: approvalPending ? 15 : (authenticated ? 5 : 8),
    paddingLength: 2,
    containerID: CONTAINER_STATUS, containerName: 'status',
    content: statusText,
    isEventCapture: 0,
  });

  let outputText: string;
  if (!connected)          outputText = `Connecting...\n${RELAY_URL}`;
  else if (!authenticated) outputText = 'Auth failed.\n\nCheck RELAY_TOKEN matches\nthe server.';
  else                     outputText = lines.map(l => truncate(stripAnsi(l))).join('\n') || '(no output)';

  const outputContainer = new TextContainerProperty({
    xPosition: 0, yPosition: 34,
    width: DISPLAY_WIDTH, height: 220,
    borderWidth: 0, borderColor: 5, paddingLength: 4,
    containerID: CONTAINER_OUTPUT, containerName: 'output',
    content: outputText,
    isEventCapture: 0,
  });

  let hintsText: string;
  if (!authenticated)       hintsText = 'Not connected';
  else if (approvalPending) hintsText = '[tap]=YES  [dbl]=NO  [▲▼]=scroll';
  else if (isLatest)        hintsText = '[▲]=up   [dbl]=latest';
  else                      hintsText = '[▲]=up  [▼]=down  [dbl]=latest';

  const hintsContainer = new TextContainerProperty({
    xPosition: 0, yPosition: 256,
    width: DISPLAY_WIDTH, height: 32,
    borderWidth: 1, borderColor: 5, paddingLength: 2,
    containerID: CONTAINER_HINTS, containerName: 'hints',
    content: hintsText,
    isEventCapture: 0,
  });

  // Invisible overlay that captures all input events without interfering
  // with firmware scroll (which would swallow our scroll events)
  const eventsContainer = new TextContainerProperty({
    xPosition: 0, yPosition: 34,
    width: DISPLAY_WIDTH, height: 220,
    borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: CONTAINER_EVENTS, containerName: 'events',
    content: ' ',
    isEventCapture: 1,
  });

  if (!pageCreated) {
    const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 4,
      textObject: [statusContainer, outputContainer, hintsContainer, eventsContainer],
    }));
    console.log('[display] createStartUpPageContainer result:', result);
    pageCreated = true;
  } else {
    await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: CONTAINER_STATUS, containerName: 'status',
      content: statusText, contentOffset: 0, contentLength: statusText.length,
    }));
    await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: CONTAINER_OUTPUT, containerName: 'output',
      content: outputText, contentOffset: 0, contentLength: outputText.length,
    }));
    await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: CONTAINER_HINTS, containerName: 'hints',
      content: hintsText, contentOffset: 0, contentLength: hintsText.length,
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
        allLines = (msg.lines as string[]).filter(l => l.trim().length > 0);
        approvalPending = msg.approvalPending ?? false;

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
    console.log('[event] raw:', JSON.stringify(event));

    // Events arrive on different paths depending on type:
    //   - scroll/click via text capture -> textEvent (with eventType)
    //   - double click -> sysEvent (with eventType=3)
    //   - click -> sysEvent (eventType=0, stripped by protobuf as default)
    // So: CLICK_EVENT=0 gets omitted. Default to CLICK_EVENT when eventType is missing.
    let type: OsEventTypeList | undefined;
    if (event.textEvent) {
      type = event.textEvent.eventType ?? OsEventTypeList.CLICK_EVENT;
      console.log('[event] textEvent, eventType=', event.textEvent.eventType, '→ type=', type);
    } else if (event.sysEvent) {
      type = event.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT;
      console.log('[event] sysEvent, eventType=', event.sysEvent.eventType, '→ type=', type);
    } else {
      console.log('[event] no textEvent or sysEvent — ignoring');
    }

    if (type === undefined || type === null) return;
    if (!authenticated) return;

    console.log('[event] resolved type=', type, 'approvalPending=', approvalPending);

    switch (type) {
      case OsEventTypeList.SCROLL_TOP_EVENT:
        scrollOffset = clampOffset(scrollOffset - 1);
        renderDisplay();
        break;

      case OsEventTypeList.SCROLL_BOTTOM_EVENT:
        scrollOffset = clampOffset(scrollOffset + 1);
        renderDisplay();
        break;

      case OsEventTypeList.CLICK_EVENT:
        if (approvalPending) {
          sendToRelay({ type: 'approve' });
          approvalPending = false;
          renderDisplay();
        }
        break;

      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        if (approvalPending) {
          sendToRelay({ type: 'reject' });
          approvalPending = false;
        }
        scrollOffset = maxOffset();
        renderDisplay();
        break;
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[plugin] Waiting for Even App Bridge...');
  bridge = await waitForEvenAppBridge();
  console.log('[plugin] Bridge ready');

  allLines = ['Connecting...'];
  await renderDisplay();

  setupInput();
  await connectRelay(RELAY_URL);
}

main().catch(console.error);
