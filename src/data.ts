// Centralised data collection — interval-based polling for all dashboard data.

import * as fs from 'fs';
import * as path from 'path';
import { parseSession, SessionData } from './utils/parseSession.js';
import { collectStats, SysStats } from './hooks/useSysStats.js';
import { detectAgents, CodingAgent, CodingAgentStats } from './hooks/useCodingAgents.js';
import { loadCronJobs, CronJob, CronStats } from './hooks/useCronJobs.js';
import { loadSystemCron, SystemCronJob, SystemCronStats } from './hooks/useSystemCron.js';
import { loadSessionsData } from './hooks/useSubAgents.js';
import {
  SESSIONS_DIR, MAX_SESSIONS,
  POLL_AGENTS, POLL_CODING, POLL_STATS, POLL_CRON, POLL_SYSCRON,
} from './utils/config.js';

export interface AgentStats {
  total: number;
  running: number;
  complete: number;
  failed: number;
}

export interface DashboardData {
  agents: SessionData[];
  agentStats: AgentStats;
  agentError: string | null;
  codingAgents: CodingAgent[];
  codingStats: CodingAgentStats;
  cronJobs: CronJob[];
  cronStats: CronStats;
  cronWarning: string | null;
  systemCronJobs: SystemCronJob[];
  systemCronStats: SystemCronStats;
  sysCronWarning: string | null;
  sysStats: SysStats;
}

function loadAgents(showAll: boolean): { agents: SessionData[]; error: string | null } {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) {
      return { agents: [], error: `Sessions directory not found: ${SESSIONS_DIR}` };
    }

    const { labels, activeSessionIds, subagentSessionIds } = loadSessionsData();

    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl') && !f.includes('.lock') && !f.includes('.deleted'))
      .map(f => path.join(SESSIONS_DIR, f));

    let sessions = files
      .map(f => {
        const session = parseSession(f);
        if (!session) return null;
        const sessionId = path.basename(f, '.jsonl');
        if (!subagentSessionIds.has(sessionId)) return null;

        const label = labels.get(sessionId);
        if (label) session.label = label;

        if (activeSessionIds.has(sessionId)) {
          session.status = 'running';
        } else if (session.status === 'running') {
          session.status = 'complete';
        }
        return session;
      })
      .filter((s): s is SessionData => s !== null)
      .sort((a, b) => b.startTime - a.startTime);

    if (!showAll) {
      sessions = sessions.filter(s => s.status === 'running');
    } else {
      sessions = sessions.slice(0, MAX_SESSIONS);
    }

    return { agents: sessions, error: null };
  } catch (err) {
    return { agents: [], error: `Error loading sessions: ${err}` };
  }
}

export class DataCollector {
  // Cached data
  private _agents: SessionData[] = [];
  private _agentError: string | null = null;
  private _codingAgents: CodingAgent[] = [];
  private _cronJobs: CronJob[] = [];
  private _cronWarning: string | null = null;
  private _sysCronJobs: SystemCronJob[] = [];
  private _sysCronWarning: string | null = null;
  private _sysStats: SysStats;

  // Last poll times
  private lastAgent = 0;
  private lastCoding = 0;
  private lastCron = 0;
  private lastSysCron = 0;
  private lastStats = 0;

  constructor() {
    this._sysStats = collectStats();
    this.lastStats = Date.now();
  }

  collect(showAll: boolean): DashboardData {
    const now = Date.now();

    if (now - this.lastAgent >= POLL_AGENTS) {
      const r = loadAgents(showAll);
      this._agents = r.agents;
      this._agentError = r.error;
      this.lastAgent = now;
    }

    if (now - this.lastCoding >= POLL_CODING) {
      this._codingAgents = detectAgents();
      this.lastCoding = now;
    }

    if (now - this.lastCron >= POLL_CRON) {
      const r = loadCronJobs();
      this._cronJobs = r.jobs;
      this._cronWarning = r.warning;
      this.lastCron = now;
    }

    if (now - this.lastSysCron >= POLL_SYSCRON) {
      const r = loadSystemCron();
      if (r.succeeded) {
        this._sysCronJobs = r.jobs;
        this._sysCronWarning = null;
      } else {
        this._sysCronWarning = 'crontab -l failed';
      }
      this.lastSysCron = now;
    }

    if (now - this.lastStats >= POLL_STATS) {
      this._sysStats = collectStats();
      this.lastStats = now;
    }

    const agentStats: AgentStats = {
      total: this._agents.length,
      running: this._agents.filter(a => a.status === 'running').length,
      complete: this._agents.filter(a => a.status === 'complete').length,
      failed: this._agents.filter(a => a.status === 'failed').length,
    };

    const codingStats: CodingAgentStats = {
      total: this._codingAgents.length,
      cc: this._codingAgents.filter(a => a.type === 'CC').length,
      ghcp: this._codingAgents.filter(a => a.type === 'GHCP').length,
      codex: this._codingAgents.filter(a => a.type === 'Codex').length,
    };

    const cronStats: CronStats = {
      total: this._cronJobs.length,
      healthy: this._cronJobs.filter(j => j.lastStatus === 'ok').length,
      erroring: this._cronJobs.filter(j => j.consecutiveErrors > 0).length,
      running: this._cronJobs.filter(j => j.isRunning).length,
    };

    const systemCronStats: SystemCronStats = { total: this._sysCronJobs.length };

    return {
      agents: this._agents,
      agentStats,
      agentError: this._agentError,
      codingAgents: this._codingAgents,
      codingStats,
      cronJobs: this._cronJobs,
      cronStats,
      cronWarning: this._cronWarning,
      systemCronJobs: this._sysCronJobs,
      systemCronStats,
      sysCronWarning: this._sysCronWarning,
      sysStats: this._sysStats,
    };
  }
}
