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
  const inChoice   = currentPrompt?.kind === 'choice';

  let statusText: string;
  if (!connected)       statusText = '○ CONNECTING...';
  else if (!authenticated) statusText = '○ AUTH FAILED';
  else if (inChoice) {
    const p = currentPrompt as Extract<Prompt, { kind: 'choice' }>;
    statusText = `● CHOOSE  ${selectedChoiceIndex + 1}/${p.options.length}`;
  }
  else if (currentPrompt?.kind === 'yn') statusText = `● LIVE  !! APPROVE  ${topLine}-${bottomLine}/${allLines.length}`;
  else                  statusText = `● LIVE  ${topLine}-${bottomLine}/${allLines.length}`;

  const statusContainer = new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: DISPLAY_WIDTH, height: 32,
    borderWidth: 1,
    borderColor: currentPrompt ? 15 : (authenticated ? 5 : 8),
    paddingLength: 2,
    containerID: CONTAINER_STATUS, containerName: 'status',
    content: statusText,
    isEventCapture: 0,
  });

  let outputText: string;
  if (!connected)          outputText = `Connecting...\n${RELAY_URL}`;
  else if (!authenticated) outputText = 'Auth failed.\n\nCheck RELAY_TOKEN matches\nthe server.';
  else if (inChoice) {
    const p = currentPrompt as Extract<Prompt, { kind: 'choice' }>;
    const header = p.question ? truncate(p.question) + '\n' : '';
    const optionLines = p.options.map((opt, i) => {
      const marker = i === selectedChoiceIndex ? '▶' : ' ';
      return truncate(`${marker} ${i + 1}. ${opt}`);
    });
    outputText = header + optionLines.join('\n');
  }
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
  if (!authenticated)                    hintsText = 'Not connected';
  else if (inChoice)                     hintsText = '[▲▼]=select  [tap]=confirm  [dbl]=cancel';
  else if (currentPrompt?.kind === 'yn') hintsText = '[tap]=YES  [dbl]=NO  [▲▼]=scroll';
  else if (isLatest)                     hintsText = '[▲]=up   [dbl]=latest';
  else                                   hintsText = '[▲]=up  [▼]=down  [dbl]=latest';

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
        const prevPromptKey = promptKey(currentPrompt);
        allLines = (msg.lines as string[]).filter(l => l.trim().length > 0);
        currentPrompt = (msg.prompt ?? null) as Prompt | null;

        // Seed the local cursor from the server's parsed selection whenever
        // a new choice prompt appears (new prompt, or options changed).
        const newPromptKey = promptKey(currentPrompt);
        if (currentPrompt?.kind === 'choice' && newPromptKey !== prevPromptKey) {
          selectedChoiceIndex = currentPrompt.selectedIndex;
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

    const inChoice = currentPrompt?.kind === 'choice';

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
          // Local cancel: stop showing the choice UI on the glasses. The
          // server still has the prompt active until the user resolves it
          // elsewhere (e.g. Esc in the actual terminal).
          currentPrompt = null;
          scrollOffset = maxOffset();
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
  console.log('[plugin] Waiting for Even App Bridge...');
  bridge = await waitForEvenAppBridge();
  console.log('[plugin] Bridge ready');

  allLines = ['Connecting...'];
  await renderDisplay();

  setupInput();
  await connectRelay(RELAY_URL);
}

main().catch(console.error);
