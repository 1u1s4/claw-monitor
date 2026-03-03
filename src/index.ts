#!/usr/bin/env node
// Raw ANSI renderer with alternate screen buffer + internal scrolling.
// Uses alternate screen so the user's original scrollback is preserved on exit.
// PgUp/PgDown/Home/End let the user scroll through the dashboard.

import { DataCollector } from './data.js';
import { renderFrame, getBoxWidth, RenderState } from './render.js';
import { CURSOR_HOME, HIDE_CURSOR, SHOW_CURSOR, ERASE_BELOW } from './utils/ansi.js';

const ALT_SCREEN_ON  = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';

// Spinner chars — stripped for stable comparison to avoid needless redraws
const SPINNER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;

// ── State ──────────────────────────────────────────────────────────────
const state: RenderState = {
  selectedIdx: 0,
  expandedIdx: null,
  showAll: false,
};

const collector = new DataCollector();
let prevStable = '';
let prevLines: string[] = [];
let scrollOffset = 0;
let forceRedraw = false;
let agentCount = 0;

// ── Render loop ────────────────────────────────────────────────────────

function render() {
  const data = collector.collect(state.showAll);
  agentCount = data.agents.length;

  // Clamp agent selection
  if (agentCount === 0) {
    state.selectedIdx = 0;
    state.expandedIdx = null;
  } else if (state.selectedIdx >= agentCount) {
    state.selectedIdx = agentCount - 1;
  }

  const frame = renderFrame(data, state, getBoxWidth());
  const stable = frame.replace(SPINNER_RE, '');
  const contentChanged = stable !== prevStable;

  if (contentChanged) {
    prevStable = stable;
    prevLines = frame.split('\n');
    // If content grew taller, auto-scroll to bottom; if user scrolled, keep position
    const termRows = process.stdout.rows || 80;
    const maxScroll = Math.max(0, prevLines.length - termRows);
    if (scrollOffset > maxScroll) scrollOffset = maxScroll;
  }

  if (contentChanged || forceRedraw) {
    writeViewport();
    forceRedraw = false;
  }
}

function writeViewport() {
  const termRows = process.stdout.rows || 80;
  const totalLines = prevLines.length;
  const maxScroll = Math.max(0, totalLines - termRows);
  scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));

  // Slice visible portion
  const visible = prevLines.slice(scrollOffset, scrollOffset + termRows);

  // Add scroll indicators if content is truncated
  if (totalLines > termRows) {
    if (scrollOffset > 0) {
      visible[0] = `  ▲ ${scrollOffset} more line${scrollOffset !== 1 ? 's' : ''} above (PgUp/Home)`;
    }
    const below = totalLines - scrollOffset - termRows;
    if (below > 0) {
      visible[visible.length - 1] = `  ▼ ${below} more line${below !== 1 ? 's' : ''} below (PgDn/End)`;
    }
  }

  // Append \x1b[K (erase to end of line) to each line so remnants of
  // the previous frame's longer lines don't show through.
  const CLEAR_EOL = '\x1b[K';
  process.stdout.write(CURSOR_HOME + visible.map(l => l + CLEAR_EOL).join('\n') + '\n' + ERASE_BELOW);
}

// ── Keyboard handling ──────────────────────────────────────────────────

function handleKey(buf: Buffer) {
  const key = buf.toString('utf8');

  // Ctrl+C
  if (key === '\x03') { cleanup(); process.exit(0); }
  // q
  if (key === 'q') { cleanup(); process.exit(0); }

  const termRows = process.stdout.rows || 80;
  const pageSize = Math.max(1, termRows - 2);

  // Scroll keys
  if (key === '\x1b[5~') { scrollOffset = Math.max(0, scrollOffset - pageSize); forceRedraw = true; render(); return; } // PgUp
  if (key === '\x1b[6~') { scrollOffset += pageSize; forceRedraw = true; render(); return; } // PgDn
  if (key === '\x1b[H' || key === '\x1b[1~') { scrollOffset = 0; forceRedraw = true; render(); return; } // Home
  if (key === '\x1b[F' || key === '\x1b[4~') { scrollOffset = Infinity; forceRedraw = true; render(); return; } // End

  // a — toggle show all
  if (key === 'a') { state.showAll = !state.showAll; forceRedraw = true; render(); return; }
  // Arrow up — agent selection
  if (key === '\x1b[A' && agentCount > 0) {
    state.selectedIdx = Math.max(0, state.selectedIdx - 1);
    forceRedraw = true; render(); return;
  }
  // Arrow down — agent selection
  if (key === '\x1b[B' && agentCount > 0) {
    state.selectedIdx = Math.min(agentCount - 1, state.selectedIdx + 1);
    forceRedraw = true; render(); return;
  }
  // Enter — expand/collapse agent
  if (key === '\r' && agentCount > 0) {
    state.expandedIdx = state.expandedIdx === state.selectedIdx ? null : state.selectedIdx;
    forceRedraw = true; render(); return;
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────

function cleanup() {
  clearInterval(renderTimer);
  process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  console.log('\n👋 Goodbye!\n');
}

// Enter alternate screen, hide cursor
process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR);

// Set up raw stdin for keypress
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleKey);
}

// Initial render + interval
render();
const renderTimer = setInterval(render, 500);

// Handle resize
process.stdout.on('resize', () => { forceRedraw = true; render(); });

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
