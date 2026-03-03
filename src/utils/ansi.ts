// ANSI escape code helpers for raw terminal rendering.

const ESC = '\x1b[';

// ── Cursor & screen ────────────────────────────────────────────────────
export const CURSOR_HOME = ESC + 'H';
export const ERASE_BELOW = ESC + 'J';
export const HIDE_CURSOR = ESC + '?25l';
export const SHOW_CURSOR = ESC + '?25h';

// ── Style resets ───────────────────────────────────────────────────────
const RESET = ESC + '0m';
const BOLD  = ESC + '1m';
const DIM   = ESC + '2m';

// ── Foreground colors ──────────────────────────────────────────────────
const FG: Record<string, string> = {
  red:     ESC + '31m',
  green:   ESC + '32m',
  yellow:  ESC + '33m',
  blue:    ESC + '34m',
  magenta: ESC + '35m',
  cyan:    ESC + '36m',
  white:   ESC + '37m',
  gray:    ESC + '90m',
};

// ── Composable style helpers ───────────────────────────────────────────

export function c(text: string, color: string): string {
  const code = FG[color];
  return code ? code + text + RESET : text;
}

export function bold(text: string, color?: string): string {
  const fg = color ? (FG[color] || '') : '';
  return BOLD + fg + text + RESET;
}

export function dim(text: string, color?: string): string {
  const fg = color ? (FG[color] || '') : '';
  return DIM + fg + text + RESET;
}

// ── Spinner ────────────────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinner(color: string = 'cyan'): string {
  const idx = Math.floor(Date.now() / 120) % SPINNER_FRAMES.length;
  return c(SPINNER_FRAMES[idx], color);
}
