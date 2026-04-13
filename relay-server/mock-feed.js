/**
 * Mock feed script — starts the relay in mock mode and feeds it test lines.
 * Usage: RELAY_TOKEN=... node mock-feed.js
 */
'use strict';

const { fork } = require('child_process');
const path = require('path');

const server = fork(path.join(__dirname, 'server.js'), ['--stdin-mock'], {
  stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
  env: process.env,
});

const lines = [
  { delay: 3000, text: '⠋ Reading project files...' },
  { delay: 1500, text: '  src/main.ts' },
  { delay: 800,  text: '  src/utils.ts' },
  { delay: 800,  text: '  package.json' },
  { delay: 2000, text: '✓ Read 3 files' },
  { delay: 1500, text: '' },
  { delay: 1000, text: '⠋ Analyzing code structure...' },
  { delay: 2500, text: '✓ Analysis complete' },
  { delay: 1500, text: '' },
  { delay: 1000, text: 'I want to refactor the auth module' },
  { delay: 1000, text: 'to use async/await instead of' },
  { delay: 1000, text: 'callbacks. This will touch 3 files.' },
  { delay: 2000, text: '' },
  { delay: 1500, text: 'Do you want to proceed? (y/n)' },
];

let i = 0;
function sendNext() {
  if (i >= lines.length) {
    console.log('\n[mock-feed] All lines sent. Relay still running — Ctrl+C to stop.');
    return;
  }
  const { delay, text } = lines[i++];
  setTimeout(() => {
    server.stdin.write(text + '\n');
    sendNext();
  }, delay);
}

server.on('spawn', () => {
  console.log('[mock-feed] Relay started, feeding test lines in 3s...\n');
  sendNext();
});

process.on('SIGINT', () => {
  server.kill();
  process.exit(0);
});
