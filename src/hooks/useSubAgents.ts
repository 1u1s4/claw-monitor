import * as fs from 'fs';
import * as path from 'path';
import { parseSession, SessionData } from '../utils/parseSession.js';
import { SESSIONS_DIR, SESSIONS_JSON, MAX_SESSIONS } from '../utils/config.js';


interface SessionMeta {
  sessionId: string;
  label?: string;
  updatedAt?: number;
  abortedLastRun?: boolean;
}

export interface SessionsData {
  labels: Map<string, string>;
  activeSessionIds: Set<string>;
  subagentSessionIds: Set<string>;
}

// Load metadata from OpenClaw's sessions.json
export function loadSessionsData(): SessionsData {
  const labels = new Map<string, string>();
  const activeSessionIds = new Set<string>();
  const subagentSessionIds = new Set<string>();
  
  try {
    if (fs.existsSync(SESSIONS_JSON)) {
      const stats = fs.statSync(SESSIONS_JSON);
      const data = JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf-8'));
      const now = Date.now();
      
      for (const [key, value] of Object.entries(data)) {
        const meta = value as SessionMeta;
        if (!meta.sessionId) continue;
        
        // Track if this is a subagent
        if (key.includes('subagent')) {
          subagentSessionIds.add(meta.sessionId);
          
          // Store label if present
          if (meta.label) {
            labels.set(meta.sessionId, meta.label);
          }
          
          // Check if recently active (within last 60 seconds)
          if (meta.updatedAt && (now - meta.updatedAt) < 60000) {
            activeSessionIds.add(meta.sessionId);
          }
        }
      }
    }
  } catch {
    // Ignore errors
  }
  
  return { labels, activeSessionIds, subagentSessionIds };
}
