// Raw-ANSI frame renderer for the terminal dashboard.
// Each section appends lines to an array; the final join('\n') is the frame.

import { bold, dim, c, spinner } from './utils/ansi.js';
import { fit } from './utils/cronUtils.js';
import { formatElapsed, SessionData } from './utils/parseSession.js';
import { WARN_THRESHOLD, CRIT_THRESHOLD, BAR_WIDTH, MIN_BOX_WIDTH, MAX_BOX_WIDTH } from './utils/config.js';
import type { DashboardData } from './data.js';
import type { CodingAgent, AgentType } from './hooks/useCodingAgents.js';
import type { CronJob } from './hooks/useCronJobs.js';
import type { SystemCronJob } from './hooks/useSystemCron.js';
import type { SysStats, SystemdService } from './hooks/useSysStats.js';

export interface RenderState {
  selectedIdx: number;
  expandedIdx: number | null;
  showAll: boolean;
}

// ── Layout helpers ─────────────────────────────────────────────────────

export function getBoxWidth(): number {
  const cols = process.stdout.columns || 80;
  return Math.max(MIN_BOX_WIDTH, Math.min(MAX_BOX_WIDTH, cols));
}

function pad(text: string, width: number): string {
  const gap = width - stripAnsi(text).length;
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

// Strip ANSI escapes to measure visible length
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function visLen(s: string): number {
  return stripAnsi(s).length;
}

// ── Coding agent helpers ───────────────────────────────────────────────

function codingIcon(type: AgentType): string {
  switch (type) {
    case 'CC':   return '\u{1F916}';  // 🤖
    case 'GHCP': return '\u{1F419}';  // 🐙
    case 'Codex': return '\u{1F4E6}'; // 📦
  }
}

function codingLabel(type: AgentType): string {
  switch (type) {
    case 'CC':   return 'Claude Code';
    case 'GHCP': return 'GH Copilot';
    case 'Codex': return 'Codex';
  }
}

// ── Status helpers ─────────────────────────────────────────────────────

function statusIcon(status: string): string {
  switch (status) {
    case 'running':  return '🔵';
    case 'complete': return '✅';
    case 'failed':   return '❌';
    default:         return '?';
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'running':  return 'cyan';
    case 'complete': return 'green';
    case 'failed':   return 'red';
    default:         return 'white';
  }
}

// ── Bar chart helper ───────────────────────────────────────────────────

function barColor(pct: number): string {
  if (pct >= CRIT_THRESHOLD) return 'red';
  if (pct >= WARN_THRESHOLD) return 'yellow';
  return 'green';
}

function barLine(label: string, pct: number, detail: string, barW: number, colW: number): string {
  const filled = Math.round((pct / 100) * barW);
  const empty = barW - filled;
  const color = barColor(pct);
  const pctStr = `${pct}%`.padStart(4);

  const raw = `${label} [${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pctStr}  ${detail}`;
  const visW = raw.length;
  const padN = Math.max(0, colW - visW);

  return bold(label) + ' ' + dim('[') + c('█'.repeat(filled), color) + dim('░'.repeat(empty)) + dim(']') + ' ' + bold(pctStr, color) + '  ' + dim(detail) + ' '.repeat(padN);
}

// ── K8s label helper ───────────────────────────────────────────────────

function k8sLabelFromName(name: string): string {
  const m = name.match(/\((k[38]s)\)$/);
  return m ? m[1] : 'k8s';
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN RENDER
// ═══════════════════════════════════════════════════════════════════════

export function renderFrame(data: DashboardData, state: RenderState, boxWidth: number): string {
  const innerWidth = boxWidth - 2;
  const lines: string[] = [];

  // ── Header ───────────────────────────────────────────────────────────
  lines.push(dim('── ') + c('🦞', 'red') + bold(' claw-monitor ') + dim('─'.repeat(boxWidth - 19)));
  lines.push(' ');

  // ── Coding Agents ────────────────────────────────────────────────────
  if (data.codingAgents.length > 0) {
    lines.push(
      '   ' + bold('Coding Agents', 'magenta') + dim(' (') + bold(String(data.codingStats.total), 'magenta') + dim(')') +
      ' '.repeat(Math.max(1, innerWidth - 2 - 14 - 2 - String(data.codingStats.total).length - 1))
    );
    lines.push(' ');

    for (const agent of data.codingAgents) {
      lines.push(...renderCodingAgent(agent, innerWidth));
      lines.push(' ');
    }

    lines.push(dim('─'.repeat(boxWidth)));
    lines.push(' ');
  }

  // ── Error ────────────────────────────────────────────────────────────
  if (data.agentError) {
    lines.push('   ' + c('⚠  ' + data.agentError, 'yellow'));
  }

  // ── Sub-Agents header ────────────────────────────────────────────────
  if (data.agents.length > 0 || !data.agentError) {
    lines.push(
      '   ' + bold('Sub-Agents', 'cyan') + dim(' (') + bold(String(data.agentStats.total), 'cyan') + dim(')') +
      ' '.repeat(Math.max(1, innerWidth - 2 - 10 - 2 - String(data.agentStats.total).length - 1))
    );
  }

  // ── Empty state ──────────────────────────────────────────────────────
  if (!data.agentError && data.agents.length === 0) {
    lines.push('   ' + c('No running sessions.', 'green'));
    lines.push('   ' + dim('Press ') + c('a', 'cyan') + dim(' to show recent history.'));
  }

  // ── Attach commands ──────────────────────────────────────────────────
  lines.push(' ');
  lines.push(
    '   ' + c('cc-attach', 'cyan') + dim(': Claude Code │ ') +
    c('codex-attach', 'cyan') + dim(': Codex │ ') +
    c('copilot-attach', 'cyan') + dim(': Copilot CLI')
  );
  lines.push(dim('  Detach: Ctrl+B then D'));

  // ── Agent cards ──────────────────────────────────────────────────────
  if (data.agents.length > 0) {
    lines.push(' ');
    for (let idx = 0; idx < data.agents.length; idx++) {
      lines.push(...renderAgentCard(data.agents[idx], innerWidth, idx === state.selectedIdx, idx === state.expandedIdx));
      lines.push(' ');
    }
  }

  lines.push(' ');

  // ── Cron Jobs ────────────────────────────────────────────────────────
  if (data.cronJobs.length > 0 || data.cronWarning) {
    lines.push(dim('─'.repeat(boxWidth)));
    lines.push(' ');
    if (data.cronJobs.length > 0) {
      lines.push(...renderCronSection(data.cronJobs, data.cronStats, innerWidth));
    }
    if (data.cronWarning) {
      lines.push('   ' + c('⚠ ' + data.cronWarning, 'yellow'));
    }
    lines.push(' ');
  }

  // ── System Cron ──────────────────────────────────────────────────────
  if (data.systemCronJobs.length > 0 || data.sysCronWarning) {
    if (data.cronJobs.length === 0 && !data.cronWarning) {
      lines.push(dim('─'.repeat(boxWidth)));
      lines.push(' ');
    }
    if (data.systemCronJobs.length > 0) {
      lines.push(...renderSystemCron(data.systemCronJobs, data.systemCronStats, innerWidth));
    }
    if (data.sysCronWarning) {
      lines.push('   ' + c('⚠ ' + data.sysCronWarning, 'yellow'));
    }
    lines.push(' ');
  }

  // ── System Stats ─────────────────────────────────────────────────────
  lines.push(...renderSysStats(data.sysStats, innerWidth));

  // ── Footer ───────────────────────────────────────────────────────────
  lines.push(...renderFooter(data.agentStats, data.codingStats.total, boxWidth));

  // ── Help hint ────────────────────────────────────────────────────────
  let helpLine = dim('Press ') + c('q', 'cyan') + dim(' quit | ') +
    c('a', 'cyan') + dim(' toggle ') +
    c(state.showAll ? 'all' : 'running', state.showAll ? 'green' : 'yellow');

  if (data.agents.length > 0) {
    helpLine += dim(' | ') + c('↑↓', 'cyan') + dim(' select | ') + c('↵', 'cyan') + dim(' expand');
  }

  helpLine += dim(' | ') + c('PgUp/Dn', 'cyan') + dim(' scroll');

  helpLine += dim(' | ') +
    c(process.platform === 'darwin' ? '⌘' : 'Ctrl', 'cyan') +
    dim('+') + c('-/+', 'cyan') + dim(' zoom');

  lines.push('');
  lines.push(helpLine);

  return lines.join('\n') + '\n';
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION RENDERERS
// ═══════════════════════════════════════════════════════════════════════

function renderCodingAgent(agent: CodingAgent, bw: number): string[] {
  const icon = codingIcon(agent.type);
  const label = codingLabel(agent.type);
  const pidStr = `PID ${agent.pid}`;

  const l1 = ' ' + icon + ' ' + bold(label, 'magenta') + '  ' + spinner() + ' ' + c(pidStr, 'magenta') + '  ' + dim(agent.elapsed);
  const l2 = dim('    └─ ') + dim(agent.command);
  return [l1, l2];
}

function renderAgentCard(agent: SessionData, bw: number, isSelected: boolean, isExpanded: boolean): string[] {
  const { label, status, elapsed, currentTool, toolArgs, toolCount, recentTools, errorDetails } = agent;
  const col = statusColor(status);

  // Clean label
  let cleanLabel = label
    .replace(/^\[.*?\]\s*/, '')
    .replace(/^(Deep research task|Search the internet for|I'd like you to)[:\s]+/i, '')
    .replace(/^(Are you there|Any updates|OK|Hi|Hello)[?\s]*/i, '')
    .trim();

  const maxLabelLen = 28;
  const displayLabel = cleanLabel.length > maxLabelLen
    ? cleanLabel.substring(0, maxLabelLen - 3) + '...'
    : cleanLabel;

  const statusText = status;
  const elapsedStr = formatElapsed(elapsed);

  const detailText = status === 'running' && currentTool
    ? `${currentTool.length > 10 ? currentTool.substring(0, 7) + '...' : currentTool}${toolArgs ? `: "${toolArgs.substring(0, 25)}${toolArgs.length > 25 ? '...' : ''}"` : ''}`
    : `Finished with ${toolCount} tool call${toolCount !== 1 ? 's' : ''}`;

  const sel = isSelected ? c('▸', 'cyan') : ' ';
  const spin = status === 'running' ? spinner() + ' ' : '';

  const lines: string[] = [];

  lines.push(' ' + sel + statusIcon(status) + ' ' + bold(displayLabel, col) + '  ' + spin + c(statusText, col) + '  ' + dim(elapsedStr));
  lines.push(dim('    └─ ') + dim(detailText));

  if (isExpanded) {
    if (cleanLabel.length > maxLabelLen) {
      lines.push(' ' + dim('     ' + cleanLabel));
    }
    if (recentTools.length > 0) {
      lines.push(' ' + c('     Recent tools:', 'cyan'));
      for (let i = 0; i < recentTools.length; i++) {
        lines.push(' ' + dim(`       ${i + 1}. ${recentTools[i]}`));
      }
    }
    if (errorDetails) {
      const errText = `     Error: ${errorDetails}`;
      const truncErr = errText.length > bw ? errText.substring(0, bw - 1) + '~' : errText;
      lines.push(' ' + c(truncErr, 'red'));
    }
  }

  return lines;
}

function renderCronSection(jobs: CronJob[], stats: { total: number; erroring: number; running: number }, bw: number): string[] {
  const nameW = 18, schedW = 18, modelW = 18, nextW = 10, durW = 8;
  const lines: string[] = [];

  // Section header
  let title = ' ' + bold('  OpenClaw Cron Jobs', 'yellow') + dim(' (') + bold(String(stats.total), 'yellow') + dim(')');
  if (stats.erroring > 0) title += dim(' · ') + bold(String(stats.erroring), 'red') + c(' failing', 'red');
  if (stats.running > 0) title += dim(' · ') + bold(String(stats.running), 'yellow') + c(' running', 'yellow');
  lines.push(title);
  lines.push(' ');

  // Column headers
  const hdr = '  ' + fit('Name', nameW) + ' ' + fit('Schedule', schedW) + fit('Model', modelW) + fit('Next', nextW) + fit('Last', durW);
  lines.push(dim(' ' + hdr));

  // Rows
  for (const job of jobs) {
    const ch = job.isRunning ? '>' : job.consecutiveErrors > 0 ? '!' : job.lastStatus === 'ok' ? '*' : '-';
    const rowColor = job.isRunning ? 'yellow' : job.consecutiveErrors > 0 ? 'red' : 'white';
    const errSuffix = job.consecutiveErrors > 1 ? ` (${job.consecutiveErrors}x)` : '';
    const durText = job.lastStatus === 'error' ? 'err' + errSuffix : job.lastDuration;

    const nameStr = job.consecutiveErrors > 0
      ? c(fit(job.name, nameW), 'red')
      : job.isRunning
        ? bold(fit(job.name, nameW), 'yellow')
        : fit(job.name, nameW);

    lines.push(
      dim(' ') + ' ' + bold(ch, rowColor) + ' ' + nameStr + ' ' +
      dim(fit(job.schedule, schedW)) + dim(fit(job.model, modelW)) + dim(fit(job.nextRun, nextW)) +
      c(fit(durText, durW), job.consecutiveErrors > 0 ? 'red' : 'gray')
    );
  }

  return lines;
}

function renderSystemCron(jobs: SystemCronJob[], stats: { total: number }, bw: number): string[] {
  const nameW = 24, schedW = 24, nextW = 12, lastW = 8;
  const lines: string[] = [];

  lines.push(' ' + bold('  System Cron', 'blue') + dim(' (') + bold(String(stats.total), 'blue') + dim(')'));
  lines.push(' ');

  const hdr = '  ' + fit('Name', nameW) + ' ' + fit('Schedule', schedW) + fit('Next', nextW) + fit('Last', lastW);
  lines.push(dim(' ' + hdr));

  for (const job of jobs) {
    lines.push(
      dim(' ') + dim(' - ') + fit(job.name, nameW) + ' ' +
      dim(fit(job.schedule, schedW)) + dim(fit(job.nextRun, nextW)) + dim(fit('—', lastW))
    );
  }

  return lines;
}

function renderSysStats(stats: SysStats, bw: number): string[] {
  const leftW = Math.floor((bw - 5) / 2);
  const rightW = bw - 5 - leftW;
  const barW = Math.max(8, Math.min(BAR_WIDTH, Math.floor(leftW * 0.45)));
  const nameW = Math.max(8, Math.floor(rightW * 0.55));

  const leftRows = [
    { label: 'CPU ', pct: stats.cpu.percent, detail: `${stats.cpu.cores} cores` },
    { label: 'MEM ', pct: stats.mem.percent, detail: `${stats.mem.usedGB}/${stats.mem.totalGB} GB` },
    { label: 'DISK', pct: stats.disk.percent, detail: `${stats.disk.usedGB}/${stats.disk.totalGB} GB` },
  ];
  if (stats.gpu) {
    leftRows.push({ label: 'GPU ', pct: stats.gpu.percent, detail: `${stats.gpu.memUsedMB}/${stats.gpu.memTotalMB} MB` });
  }

  const hasDocker = stats.docker.available && stats.docker.running > 0;
  const dockerCount = hasDocker ? stats.docker.containers.length : 0;
  const sysdCount = stats.systemd?.length ?? 0;
  const hasSystemd = sysdCount > 0;
  const hasRight = hasDocker || hasSystemd;

  // Build right-column rows as strings
  const rightLines: string[] = [];
  if (hasRight) {
    const dockerPart = hasDocker ? `${stats.docker.running} container${stats.docker.running !== 1 ? 's' : ''}` : '';
    const sysdPart = hasSystemd ? `${sysdCount} systemd process${sysdCount !== 1 ? 'es' : ''}` : '';
    const hdr = [dockerPart, sysdPart].filter(Boolean).join(' and ');

    // Header row (🐳 is 2 visual cols)
    rightLines.push('🐳 ' + dim(hdr) + ' '.repeat(Math.max(0, rightW - hdr.length - 3)));

    // Docker containers
    for (let i = 0; i < dockerCount; i++) {
      const ct = stats.docker.containers[i];
      if (!ct) continue;
      const suffix = ct.source === 'k8s' ? ` (${k8sLabelFromName(ct.name)})` : '';
      const baseName = suffix ? ct.name.replace(/\s*\(k[38]s\)$/, '') : ct.name;
      const nameAvail = nameW - suffix.length;
      const cName = nameAvail > 3
        ? fit(baseName, nameAvail) + suffix
        : fit(ct.name, nameW);
      const paddedName = cName.padEnd(nameW);
      const statusMax = Math.max(1, rightW - nameW - 1);
      const cStatus = ct.status.length > statusMax ? ct.status.substring(0, statusMax - 1) + '~' : ct.status;
      rightLines.push(paddedName + ' ' + dim(cStatus) + ' '.repeat(Math.max(0, rightW - paddedName.length - 1 - cStatus.length)));
    }

    // Systemd services
    for (const svc of (stats.systemd || [])) {
      const isFailed = svc.status === 'failed';
      const svcColor = isFailed ? 'red' : '';
      const svcNameW = Math.max(2, nameW - 2);
      const paddedName = fit(svc.name, svcNameW).padEnd(svcNameW);
      const statusMax = Math.max(1, rightW - nameW - 1);
      const cStatus = svc.status.length > statusMax ? svc.status.substring(0, statusMax - 1) + '~' : svc.status;

      const prefix = isFailed ? c('⚙ ', 'red') : dim('⚙ ');
      const nameStr = isFailed ? c(paddedName, 'red') : paddedName;
      const statusStr = isFailed ? c(cStatus, 'red') : dim(cStatus);
      rightLines.push(prefix + nameStr + ' ' + statusStr + ' '.repeat(Math.max(0, rightW - nameW - 1 - cStatus.length)));
    }
  }

  // Interleave left bars (with spacers) and right rows
  type RowEntry = { leftIdx: number | null; isSpacer: boolean };
  const displayRows: RowEntry[] = [];
  let rightCursor = 0;

  for (let li = 0; li < leftRows.length; li++) {
    if (li > 0) {
      displayRows.push({ leftIdx: null, isSpacer: true });
      rightCursor++;
    }
    displayRows.push({ leftIdx: li, isSpacer: false });
    rightCursor++;
  }

  // Extend to fit all right-column rows
  while (rightCursor < rightLines.length) {
    displayRows.push({ leftIdx: null, isSpacer: false });
    rightCursor++;
  }

  const lines: string[] = [' '];
  let ri = 0;
  for (const row of displayRows) {
    const leftPart = row.leftIdx !== null
      ? barLine(leftRows[row.leftIdx].label, leftRows[row.leftIdx].pct, leftRows[row.leftIdx].detail, barW, leftW)
      : ' '.repeat(leftW);
    const rightPart = ri < rightLines.length ? rightLines[ri] : ' '.repeat(rightW);
    lines.push('   ' + leftPart + dim(' │ ') + rightPart);
    ri++;
  }

  // Warnings
  if (stats.warnings.length > 0) {
    lines.push(' ');
    for (const w of stats.warnings) {
      lines.push(' ' + c(`  ⚠ ${w}`, 'yellow'));
    }
  }

  return lines;
}

function renderFooter(stats: { total: number; running: number; complete: number; failed: number }, codingAgentCount: number, boxWidth: number): string[] {
  const lines: string[] = [];
  lines.push(dim('─'.repeat(boxWidth)));

  const agentWord = stats.total !== 1 ? 'agents' : 'agent';
  let footLine = '   ' + bold(String(stats.total)) + dim(' ' + agentWord) +
    dim(' │ ') + bold(String(stats.running), 'cyan') + dim(' running') +
    dim(' │ ') + bold(String(stats.complete), 'green') + dim(' complete') +
    dim(' │ ') + bold(String(stats.failed), 'red') + dim(' failed');

  if (codingAgentCount > 0) {
    footLine += dim(' │ ') + bold(String(codingAgentCount), 'magenta') + dim(' coding');
  }

  lines.push(footLine);
  lines.push(dim('─'.repeat(boxWidth)));

  return lines;
}
