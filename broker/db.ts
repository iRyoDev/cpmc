/**
 * broker/db.ts — Database setup, state management, and helper functions
 *
 * Extracted from the monolithic broker.ts. Contains all SQLite schema,
 * migrations, prepared statements, session tracking, peer cleanup,
 * rate limiting, and utility functions.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { createLogger } from "../shared/log.ts";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  BroadcastRequest,
  BroadcastResponse,
  AckMessageRequest,
  CheckAcksRequest,
  CheckAcksResponse,
  SetNameRequest,
  SetStatusRequest,
  MessageHistoryRequest,
  MessageHistoryResponse,
  Peer,
  Message,
  Task,
  Decision,
  Verification,
  ProposalVote,
} from "../shared/types.ts";

// ---- Logger ----

export const log = createLogger("broker");

// ---- DB row types (not defined in shared/types.ts) ----

export interface ProposalRow {
  id: string;
  author_id: string;
  author_name: string;
  title: string;
  description: string;
  required_votes: number;
  status: "open" | "approved" | "rejected";
  group_id: string | null;
  created_at: string;
  resolved_at: string | null;
  session_id: string;
}

export interface ApprovalRow {
  id: string;
  requester_id: string;
  approver_id: string;
  action_description: string;
  status: "pending" | "approved" | "rejected";
  group_id: string | null;
  created_at: string;
  resolved_at: string | null;
  session_id: string;
}

export interface AuditLogRow {
  id: number;
  action: string;
  actor_id: string;
  actor_name: string;
  details: string;
  group_id: string | null;
  created_at: string;
}

export interface PeerNameRow { name: string }
export interface CountRow { cnt: number }
export interface VoteCountRow { c: number }

// ---- Config constants ----

export const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
export const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${homedir()}/.claude-peers.db`;
export const SKIP_PID_CHECK = process.env.CLAUDE_PEERS_SKIP_PID_CHECK === "1";

// ---- Database setup ----

export const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// Schema migration helper -- only swallows "duplicate column" errors, rethrows real failures
function migrate(sql: string) {
  try { db.run(sql); } catch (e) {
    if (e instanceof Error && e.message.includes("duplicate column")) return;
    throw e;
  }
}

// Schema migrations
migrate("ALTER TABLE messages ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0");
migrate("ALTER TABLE peers ADD COLUMN name TEXT NOT NULL DEFAULT ''");

// NOTE: peer_groups table removed -- unused. The system uses isolation_groups + peers.group_id instead.

// Schema migrations
migrate("ALTER TABLE messages ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
migrate("ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'online'");
migrate("ALTER TABLE peers ADD COLUMN group_id TEXT DEFAULT NULL");

// Isolation groups table
db.run(`
  CREATE TABLE IF NOT EXISTS isolation_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )
`);

// --- Feature: git branch tracking (auto-grouping) ---
migrate("ALTER TABLE peers ADD COLUMN git_branch TEXT DEFAULT NULL");

// --- Feature: message pinning ---
migrate("ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");

// --- Feature: tasks ---
db.run(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    creator_id TEXT NOT NULL,
    assignee_id TEXT,
    group_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    completed_at TEXT,
    session_id TEXT NOT NULL DEFAULT ''
  )
`);

// --- Feature: audit log ---
db.run(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    group_id TEXT,
    created_at TEXT NOT NULL
  )
`);
db.run("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)");

// --- Feature: message reactions ---
db.run(`
  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    peer_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(message_id, peer_id, emoji),
    FOREIGN KEY (message_id) REFERENCES messages(id)
  )
`);

// --- Feature: approval requests ---
db.run(`
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL,
    approver_id TEXT NOT NULL,
    action_description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    group_id TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    session_id TEXT NOT NULL DEFAULT ''
  )
`);

// --- Feature: structured messages + context snapshots ---
migrate("ALTER TABLE messages ADD COLUMN msg_type TEXT DEFAULT NULL");
migrate("ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT NULL");
migrate("ALTER TABLE messages ADD COLUMN context_snapshot TEXT DEFAULT NULL");

// --- Feature: decisions board ---
db.run(`
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general',
    status TEXT NOT NULL DEFAULT 'active',
    group_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT ''
  )
`);

// --- Feature: verification protocol ---
db.run(`
  CREATE TABLE IF NOT EXISTS verifications (
    id TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL,
    verifier_id TEXT NOT NULL,
    claim TEXT NOT NULL,
    evidence_needed TEXT NOT NULL DEFAULT '',
    files_to_check TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    response TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    group_id TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    session_id TEXT NOT NULL DEFAULT ''
  )
`);

// --- Feature: consensus protocol ---
db.run(`
  CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    required_votes INTEGER NOT NULL DEFAULT 2,
    status TEXT NOT NULL DEFAULT 'open',
    group_id TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    session_id TEXT NOT NULL DEFAULT ''
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS proposal_votes (
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL,
    voter_id TEXT NOT NULL,
    voter_name TEXT NOT NULL DEFAULT '',
    vote TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(proposal_id, voter_id),
    FOREIGN KEY (proposal_id) REFERENCES proposals(id)
  )
`);

// --- Feature: active files (edit conflict detection) ---
// Stored in-memory for performance (files change frequently)
// Map<peer_id, { files: string[], updated_at: number }>
export const activeFilesMap = new Map<string, { files: string[]; updated_at: number }>();
export const ACTIVE_FILES_TIMEOUT_MS = 60_000; // expire after 60s without update

// Performance indices
db.run("CREATE INDEX IF NOT EXISTS idx_messages_to_delivered ON messages(to_id, delivered)");
db.run("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at)");
db.run("CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_decisions_category ON decisions(category)");
db.run("CREATE INDEX IF NOT EXISTS idx_verifications_session ON verifications(session_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(session_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_proposal_votes_proposal ON proposal_votes(proposal_id)");

// ---- Key-value store for persistent settings ----
db.run(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

// ---- Audit log helper ----

export function audit(action: string, actorId: string, details: string = "", groupId: string | null = null) {
  const actorRow = db.query("SELECT name FROM peers WHERE id = ?").get(actorId) as { name: string } | null;
  const actorName = actorRow?.name || (VIRTUAL_PEERS.has(actorId) ? actorId : "");
  db.run(
    "INSERT INTO audit_log (action, actor_id, actor_name, details, group_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [action, actorId, actorName, details, groupId, new Date().toISOString()]
  );
}

export const BROKER_START_TIME = Date.now();

// ---- Session tracking (persisted) ----

function loadOrCreateSessionId(): string {
  const row = db.query("SELECT value FROM kv WHERE key = 'session_id'").get() as { value: string } | null;
  if (row) return row.value;
  const id = crypto.randomUUID();
  db.run("INSERT INTO kv (key, value) VALUES ('session_id', ?)", [id]);
  return id;
}

function persistSessionId(id: string): void {
  db.run("INSERT OR REPLACE INTO kv (key, value) VALUES ('session_id', ?)", [id]);
}

// Track when the broker was last alive (survives restarts via kv table)
export const SESSION_RESET_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function updateLastAlive(): void {
  db.run("INSERT OR REPLACE INTO kv (key, value) VALUES ('last_alive', ?)", [new Date().toISOString()]);
}

// Determine if we should start a fresh session:
// Only reset if the broker has been down for > 5 minutes (based on last_alive timestamp)
// This prevents losing session continuity on fast restarts where peers reconnect quickly
function shouldResetSession(): boolean {
  const lastAliveRow = db.query("SELECT value FROM kv WHERE key = 'last_alive'").get() as { value: string } | null;
  if (lastAliveRow) {
    const downtime = Date.now() - new Date(lastAliveRow.value).getTime();
    if (downtime < SESSION_RESET_THRESHOLD_MS) return false; // fast restart, keep session
  }
  // Broker was down a long time (or first-ever start) -- check for stale state
  const peerCount = (db.query("SELECT COUNT(*) as cnt FROM peers").get() as { cnt: number }).cnt;
  if (peerCount > 0) return false;
  const recentMsg = db.query(
    "SELECT id FROM messages WHERE sent_at > ? LIMIT 1"
  ).get(new Date(Date.now() - SESSION_RESET_THRESHOLD_MS).toISOString()) as { id: number } | null;
  return !recentMsg;
}

export let currentSessionId: string;
if (shouldResetSession()) {
  currentSessionId = crypto.randomUUID();
  persistSessionId(currentSessionId);
} else {
  currentSessionId = loadOrCreateSessionId();
}
// Mark broker as alive on startup
updateLastAlive();

// ---- Typing indicators (in-memory, not persisted) ----

export const typingState = new Map<string, number>();
export const TYPING_TIMEOUT_MS = 5000;

// ---- Process checking ----

// Cross-platform process existence check (single PID -- used in handleListPeers)
export function isProcessAlive(pid: number): boolean {
  if (SKIP_PID_CHECK) return true;
  if (process.platform === "win32") {
    try {
      const proc = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]);
      const output = new TextDecoder().decode(proc.stdout);
      return output.includes(String(pid));
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

// Batched alive check -- one tasklist call for all PIDs (Windows optimization)
export function getAlivePids(pidsToCheck: number[]): Set<number> {
  if (pidsToCheck.length === 0) return new Set();
  if (SKIP_PID_CHECK) return new Set(pidsToCheck);
  if (process.platform === "win32") {
    try {
      const proc = Bun.spawnSync(["tasklist", "/FO", "CSV", "/NH"]);
      const output = new TextDecoder().decode(proc.stdout);
      const alive = new Set<number>();
      const checkSet = new Set(pidsToCheck);
      for (const line of output.split("\n")) {
        // CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
        const match = line.match(/^"[^"]*","(\d+)"/);
        if (match) {
          const pid = parseInt(match[1]!, 10);
          if (checkSet.has(pid)) alive.add(pid);
        }
      }
      return alive;
    } catch { return new Set(); }
  }
  // Unix: check each individually (signal 0 is fast)
  const alive = new Set<number>();
  for (const pid of pidsToCheck) {
    try { process.kill(pid, 0); alive.add(pid); } catch { /* dead */ }
  }
  return alive;
}

// Clean up stale peers (PIDs that no longer exist OR heartbeat expired)
export const STALE_PEER_TIMEOUT_MS = 45_000; // 3x heartbeat interval (15s)

export function cleanStalePeers() {
  const peers = db.query("SELECT id, pid, last_seen FROM peers").all() as { id: string; pid: number; last_seen: string }[];
  if (peers.length === 0) return;
  const alivePids = getAlivePids(peers.map(p => p.pid));
  const now = Date.now();
  let removed = 0;
  for (const peer of peers) {
    const lastSeenAge = now - new Date(peer.last_seen).getTime();
    // Remove if PID is dead OR if heartbeat is stale (>45s without heartbeat)
    if (!alivePids.has(peer.pid) || lastSeenAge > STALE_PEER_TIMEOUT_MS) {
      const peerInfo = db.query("SELECT name, group_id FROM peers WHERE id = ?").get(peer.id) as { name: string; group_id: string | null } | null;
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
      if (peerInfo) audit("peer.stale_cleanup", peer.id, peerInfo.name || peer.id, peerInfo.group_id);
      removed++;
    }
  }
  if (removed > 0) onStateChange?.();
}

// ---- Prepared statements ----

export const insertPeer = db.prepare(`
  INSERT INTO peers (id, name, pid, cwd, git_root, tty, summary, registered_at, last_seen, group_id, git_branch)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export const updateName = db.prepare(`
  UPDATE peers SET name = ? WHERE id = ?
`);

export const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

export const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

export const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

export const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

export const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

export const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

export const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered, session_id)
  VALUES (?, ?, ?, ?, 0, ?)
`);

export const insertMessageWithContext = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered, session_id, context_snapshot)
  VALUES (?, ?, ?, ?, 0, ?, ?)
`);

export const insertStructuredMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered, session_id, msg_type, metadata, context_snapshot)
  VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
`);

export const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

export const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

export const countUndelivered = db.prepare(`
  SELECT COUNT(*) as cnt FROM messages WHERE to_id = ? AND delivered = 0
`);

export const ackMessage = db.prepare(`
  UPDATE messages SET acknowledged = 1 WHERE id = ? AND to_id = ?
`);

export const selectSentMessages = db.prepare(`
  SELECT * FROM messages WHERE from_id = ? ORDER BY sent_at DESC LIMIT ?
`);

export const selectSessionMessages = db.prepare(`
  SELECT * FROM messages WHERE session_id = ? ORDER BY sent_at ASC LIMIT 200
`);

export const selectMessageHistory = db.prepare(`
  SELECT * FROM messages WHERE
    ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
    AND session_id = ?
  ORDER BY sent_at DESC LIMIT ?
`);

export const updateStatus = db.prepare(`
  UPDATE peers SET status = ? WHERE id = ?
`);

// ---- Constants ----

export const MAX_MESSAGE_SIZE = 65_536; // 64 KB
export const MAX_QUEUE_DEPTH = 100;
export const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
export const RATE_LIMIT_MAX = 60; // max messages per window per sender

// ---- Rate limiting ----

export const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

export function isRateLimited(senderId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(senderId);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(senderId, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// ---- Callback for state changes (set by the entry point to trigger dashboard broadcasts) ----

let onStateChange: (() => void) | null = null;

export function setOnStateChange(cb: (() => void) | null) {
  onStateChange = cb;
}

// ---- Periodic cleanup ----

// Run initial cleanup now that all state is ready
cleanStalePeers();

/**
 * Start the periodic cleanup interval. Call once from the entry point.
 * Returns the interval ID so it can be cleared if needed.
 */
export function startPeriodicCleanup(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    cleanStalePeers();
    updateLastAlive(); // persist broker liveness for session continuity across restarts
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(key);
    }
    // Expire old delivered messages (> 24h)
    db.run("DELETE FROM messages WHERE sent_at < ? AND delivered = 1",
      [new Date(now - 24 * 60 * 60 * 1000).toISOString()]);
    // Clean stale typing indicators
    for (const [key, ts] of typingState) {
      if (now - ts > TYPING_TIMEOUT_MS) typingState.delete(key);
    }
    // Push updated state to dashboard clients
    onStateChange?.();
  }, 15_000);
}

// ---- Generate peer ID ----

export function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ---- Auto-naming (slot-based, reuses freed slots) ----

export function nextPeerName(groupId: string | null = null): string {
  const groupCondition = groupId !== null
    ? "AND group_id = ?"
    : "AND group_id IS NULL";
  const params = groupId !== null ? [groupId] : [];

  const rows = db.query(
    `SELECT CAST(SUBSTR(name, 8) AS INTEGER) AS num FROM peers
     WHERE name LIKE 'claude-%' AND CAST(SUBSTR(name, 8) AS INTEGER) > 0
     ${groupCondition}
     ORDER BY num ASC`
  ).all(...params) as { num: number }[];

  let slot = 1;
  for (const row of rows) {
    if (row.num !== slot) break;
    slot++;
  }
  return `claude-${slot}`;
}

// Virtual peers (dashboard UI, CLI) -- not in the peers table but can send/receive messages
export const VIRTUAL_PEERS = new Set(["dashboard", "cli"]);

// ---- Group isolation helpers ----

export function getPeerGroupId(peerId: string): string | null | undefined {
  // Returns null for lobby peers, undefined if peer not found
  if (VIRTUAL_PEERS.has(peerId)) return null; // virtual peers are in lobby / bypass
  const row = db.query("SELECT group_id FROM peers WHERE id = ?").get(peerId) as { group_id: string | null } | null;
  if (!row) return undefined;
  return row.group_id;
}

export function canCommunicate(fromId: string, toId: string): boolean {
  // Virtual peers (dashboard, cli) can communicate with anyone
  if (VIRTUAL_PEERS.has(fromId) || VIRTUAL_PEERS.has(toId)) return true;
  const fromGroup = getPeerGroupId(fromId);
  const toGroup = getPeerGroupId(toId);
  if (fromGroup === undefined || toGroup === undefined) return false;
  // Both null (lobby) or both same group
  return fromGroup === toGroup;
}
