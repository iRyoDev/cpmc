#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { createLogger } from "./shared/log.ts";
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
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${homedir()}/.claude-peers.db`;
const SKIP_PID_CHECK = process.env.CLAUDE_PEERS_SKIP_PID_CHECK === "1";

// --- Database setup ---

const db = new Database(DB_PATH);
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

// Schema migrations
try { db.run("ALTER TABLE messages ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
try { db.run("ALTER TABLE peers ADD COLUMN name TEXT NOT NULL DEFAULT ''"); } catch { /* already exists */ }

db.run(`
  CREATE TABLE IF NOT EXISTS peer_groups (
    peer_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (peer_id, group_name),
    FOREIGN KEY (peer_id) REFERENCES peers(id)
  )
`);

// Schema migrations
try { db.run("ALTER TABLE messages ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"); } catch { /* already exists */ }
try { db.run("ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'online'"); } catch { /* already exists */ }
try { db.run("ALTER TABLE peers ADD COLUMN group_id TEXT DEFAULT NULL"); } catch { /* already exists */ }

// Isolation groups table
db.run(`
  CREATE TABLE IF NOT EXISTS isolation_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )
`);

// --- Feature: git branch tracking (auto-grouping) ---
try { db.run("ALTER TABLE peers ADD COLUMN git_branch TEXT DEFAULT NULL"); } catch { /* already exists */ }

// --- Feature: message pinning ---
try { db.run("ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }

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

// --- Feature: active files (edit conflict detection) ---
// Stored in-memory for performance (files change frequently)
// Map<peer_id, { files: string[], updated_at: number }>
const activeFilesMap = new Map<string, { files: string[]; updated_at: number }>();
const ACTIVE_FILES_TIMEOUT_MS = 60_000; // expire after 60s without update

// Performance indices
db.run("CREATE INDEX IF NOT EXISTS idx_messages_to_delivered ON messages(to_id, delivered)");
db.run("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at)");
db.run("CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id)");

const BROKER_START_TIME = Date.now();

// --- Key-value store for persistent settings ---
db.run(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

// --- Session tracking (persisted) ---
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

// Determine if we should start a fresh session:
// Only if there are zero peers AND no recent messages (last 5 minutes)
function shouldResetSession(): boolean {
  const peerCount = (db.query("SELECT COUNT(*) as cnt FROM peers").get() as { cnt: number }).cnt;
  if (peerCount > 0) return false;
  const recentMsg = db.query(
    "SELECT id FROM messages WHERE sent_at > ? LIMIT 1"
  ).get(new Date(Date.now() - 5 * 60 * 1000).toISOString()) as { id: number } | null;
  return !recentMsg;
}

let currentSessionId: string;
if (shouldResetSession()) {
  currentSessionId = crypto.randomUUID();
  persistSessionId(currentSessionId);
} else {
  currentSessionId = loadOrCreateSessionId();
}

// Typing indicators (in-memory, not persisted)
const typingState = new Map<string, number>();
const TYPING_TIMEOUT_MS = 5000;

// Cross-platform process existence check (single PID — used in handleListPeers)
function isProcessAlive(pid: number): boolean {
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

// Batched alive check — one tasklist call for all PIDs (Windows optimization)
function getAlivePids(pidsToCheck: number[]): Set<number> {
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
          const pid = parseInt(match[1], 10);
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

// Clean up stale peers (PIDs that no longer exist)
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  if (peers.length === 0) return;
  const alivePids = getAlivePids(peers.map(p => p.pid));
  for (const peer of peers) {
    if (!alivePids.has(peer.pid)) {
      db.run("DELETE FROM peer_groups WHERE peer_id = ?", [peer.id]);
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

// NOTE: initial cleanStalePeers() and setInterval are called after rateLimitMap is defined below

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, name, pid, cwd, git_root, tty, summary, registered_at, last_seen, group_id, git_branch)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateName = db.prepare(`
  UPDATE peers SET name = ? WHERE id = ?
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered, session_id)
  VALUES (?, ?, ?, ?, 0, ?)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

const countUndelivered = db.prepare(`
  SELECT COUNT(*) as cnt FROM messages WHERE to_id = ? AND delivered = 0
`);

const ackMessage = db.prepare(`
  UPDATE messages SET acknowledged = 1 WHERE id = ? AND to_id = ?
`);

const selectSentMessages = db.prepare(`
  SELECT * FROM messages WHERE from_id = ? ORDER BY sent_at DESC LIMIT ?
`);


const selectRecentMessages = db.prepare(`
  SELECT * FROM messages ORDER BY sent_at DESC LIMIT ?
`);

const selectSessionMessages = db.prepare(`
  SELECT * FROM messages WHERE session_id = ? ORDER BY sent_at ASC LIMIT 200
`);

const selectMessageHistory = db.prepare(`
  SELECT * FROM messages WHERE
    ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
    AND session_id = ?
  ORDER BY sent_at DESC LIMIT ?
`);

const updateStatus = db.prepare(`
  UPDATE peers SET status = ? WHERE id = ?
`);

// --- Constants ---

const MAX_MESSAGE_SIZE = 65_536; // 64 KB
const MAX_QUEUE_DEPTH = 100;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10; // max messages per window per sender

// --- Rate limiting ---

const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(senderId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(senderId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(senderId, { count: 1, windowStart: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT_MAX) return true;
  entry.count++;
  return false;
}

// Now that rateLimitMap exists, run initial cleanup and start periodic cleanup
cleanStalePeers();
setInterval(() => {
  cleanStalePeers();
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
  if (typeof broadcastDashboard === "function") broadcastDashboard();
}, 30_000);

// --- Input validation ---

class ValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ValidationError";
  }
}

function validateString(val: unknown, name: string): string {
  if (typeof val !== "string" || val.length === 0)
    throw new ValidationError(`'${name}' must be a non-empty string`);
  return val;
}

function validateOptionalString(val: unknown, name: string): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val !== "string")
    throw new ValidationError(`'${name}' must be a string or null`);
  return val;
}

function validateNumber(val: unknown, name: string): number {
  if (typeof val !== "number" || !Number.isFinite(val))
    throw new ValidationError(`'${name}' must be a finite number`);
  return val;
}

function validateBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object")
    throw new ValidationError("Invalid request body");
  return body as Record<string, unknown>;
}

function validateRegisterRequest(raw: unknown): RegisterRequest & { git_branch?: string | null } {
  const b = validateBody(raw);
  return {
    pid: validateNumber(b.pid, "pid"),
    cwd: validateString(b.cwd, "cwd"),
    git_root: validateOptionalString(b.git_root, "git_root"),
    tty: validateOptionalString(b.tty, "tty"),
    summary: typeof b.summary === "string" ? b.summary : "",
    git_branch: typeof b.git_branch === "string" ? b.git_branch : null,
  };
}

function validateHeartbeatRequest(raw: unknown): HeartbeatRequest {
  const b = validateBody(raw);
  return { id: validateString(b.id, "id") };
}

function validateSetSummaryRequest(raw: unknown): SetSummaryRequest {
  const b = validateBody(raw);
  return {
    id: validateString(b.id, "id"),
    summary: validateString(b.summary, "summary"),
  };
}

function validateListPeersRequest(raw: unknown): ListPeersRequest {
  const b = validateBody(raw);
  const scope = b.scope;
  if (scope !== "machine" && scope !== "directory" && scope !== "repo")
    throw new ValidationError("'scope' must be 'machine', 'directory', or 'repo'");
  return {
    scope,
    cwd: validateString(b.cwd, "cwd"),
    git_root: validateOptionalString(b.git_root, "git_root"),
    exclude_id: typeof b.exclude_id === "string" ? b.exclude_id : undefined,
  };
}

function validateSendMessageRequest(raw: unknown): SendMessageRequest {
  const b = validateBody(raw);
  return {
    from_id: validateString(b.from_id, "from_id"),
    to_id: validateString(b.to_id, "to_id"),
    text: validateString(b.text, "text"),
  };
}

function validatePollMessagesRequest(raw: unknown): PollMessagesRequest {
  const b = validateBody(raw);
  return { id: validateString(b.id, "id") };
}

function validateUnregisterRequest(raw: unknown): { id: string } {
  const b = validateBody(raw);
  return { id: validateString(b.id, "id") };
}

function validateBroadcastRequest(raw: unknown): BroadcastRequest {
  const b = validateBody(raw);
  const scope = b.scope;
  if (scope !== "machine" && scope !== "directory" && scope !== "repo")
    throw new ValidationError("'scope' must be 'machine', 'directory', or 'repo'");
  return {
    from_id: validateString(b.from_id, "from_id"),
    scope,
    cwd: validateString(b.cwd, "cwd"),
    git_root: validateOptionalString(b.git_root, "git_root"),
    text: validateString(b.text, "text"),
  };
}

function validateAckMessageRequest(raw: unknown): AckMessageRequest {
  const b = validateBody(raw);
  return {
    id: validateString(b.id, "id"),
    message_id: validateNumber(b.message_id, "message_id"),
  };
}

function validateCheckAcksRequest(raw: unknown): CheckAcksRequest {
  const b = validateBody(raw);
  return {
    from_id: validateString(b.from_id, "from_id"),
    limit: typeof b.limit === "number" ? b.limit : undefined,
  };
}


function validateSetNameRequest(raw: unknown): SetNameRequest {
  const b = validateBody(raw);
  return {
    id: validateString(b.id, "id"),
    name: validateString(b.name, "name"),
  };
}

function validateSetStatusRequest(raw: unknown): SetStatusRequest {
  const b = validateBody(raw);
  const status = b.status;
  if (status !== "online" && status !== "away" && status !== "busy" && status !== "idle")
    throw new ValidationError("'status' must be 'online', 'away', 'busy', or 'idle'");
  return { id: validateString(b.id, "id"), status };
}

function validateSetTypingRequest(raw: unknown): { id: string } {
  const b = validateBody(raw);
  return { id: validateString(b.id, "id") };
}

function validateMessageHistoryRequest(raw: unknown): MessageHistoryRequest {
  const b = validateBody(raw);
  return {
    peer_a: validateString(b.peer_a, "peer_a"),
    peer_b: validateString(b.peer_b, "peer_b"),
    limit: typeof b.limit === "number" ? b.limit : undefined,
  };
}

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Auto-naming (slot-based, reuses freed slots) ---

function nextPeerName(groupId: string | null = null): string {
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

// Virtual peers (dashboard UI, CLI) — not in the peers table but can send/receive messages
const VIRTUAL_PEERS = new Set(["dashboard", "cli"]);

// --- Group isolation helpers ---

function getPeerGroupId(peerId: string): string | null | undefined {
  // Returns null for lobby peers, undefined if peer not found
  if (VIRTUAL_PEERS.has(peerId)) return null; // virtual peers are in lobby / bypass
  const row = db.query("SELECT group_id FROM peers WHERE id = ?").get(peerId) as { group_id: string | null } | null;
  if (!row) return undefined;
  return row.group_id;
}

function canCommunicate(fromId: string, toId: string): boolean {
  // Virtual peers (dashboard, cli) can communicate with anyone
  if (VIRTUAL_PEERS.has(fromId) || VIRTUAL_PEERS.has(toId)) return true;
  const fromGroup = getPeerGroupId(fromId);
  const toGroup = getPeerGroupId(toId);
  if (fromGroup === undefined || toGroup === undefined) return false;
  // Both null (lobby) or both same group
  return fromGroup === toGroup;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest & { git_branch?: string | null }): RegisterResponse {
  const now = new Date().toISOString();
  const branch = body.git_branch ?? null;

  // Check for existing registration with this PID — preserve name and group
  const existing = db.query("SELECT id, name, group_id FROM peers WHERE pid = ?")
    .get(body.pid) as { id: string; name: string; group_id: string | null } | null;

  let groupId = existing?.group_id ?? null;

  // Auto-grouping by git branch: if peer has a branch and no existing group assignment,
  // find or create an isolation group for that branch
  if (branch && !existing?.group_id) {
    const branchGroupName = `branch/${branch}`;
    const existingGroup = db.query("SELECT id FROM isolation_groups WHERE name = ?").get(branchGroupName) as { id: string } | null;
    if (existingGroup) {
      groupId = existingGroup.id;
    } else {
      // Auto-create group for this branch
      const gid = generateId();
      db.run("INSERT INTO isolation_groups (id, name, created_at) VALUES (?, ?, ?)", [gid, branchGroupName, now]);
      groupId = gid;
    }
  }

  const name = existing ? existing.name : nextPeerName(groupId);

  // Clean up old registration
  if (existing) {
    db.run("DELETE FROM peer_groups WHERE peer_id = ?", [existing.id]);
    deletePeer.run(existing.id);
  }

  const id = generateId();
  insertPeer.run(id, name, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now, groupId, branch);
  return { id, name };
}

function handleSetName(body: SetNameRequest): { ok: boolean; error?: string } {
  const peer = db.query("SELECT id FROM peers WHERE id = ?").get(body.id) as { id: string } | null;
  if (!peer) return { ok: false, error: "Peer not found" };

  // Validate name format
  const name = body.name.trim();
  if (name.length === 0) return { ok: false, error: "Name cannot be empty" };
  if (name.length > 32) return { ok: false, error: "Name too long (max 32 characters)" };
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return { ok: false, error: "Name can only contain letters, numbers, hyphens, and underscores" };

  // Check name uniqueness
  const clash = db.query("SELECT id FROM peers WHERE name = ? AND id != ?").get(name, body.id) as { id: string } | null;
  if (clash) return { ok: false, error: `Name "${name}" is already taken` };
  updateName.run(name, body.id);
  return { ok: true };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Group isolation: filter by requesting peer's group
  if (body.exclude_id && !VIRTUAL_PEERS.has(body.exclude_id)) {
    const requesterGroup = getPeerGroupId(body.exclude_id);
    if (requesterGroup !== undefined) {
      peers = peers.filter((p) => {
        const pg = (p as any).group_id ?? null;
        return pg === requesterGroup;
      });
    }
  }

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    if (isProcessAlive(p.pid)) return true;
    deletePeer.run(p.id);
    return false;
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Rate limit per sender
  if (isRateLimited(body.from_id)) {
    return { ok: false, error: `Rate limited: max ${RATE_LIMIT_MAX} messages per minute` };
  }

  // Message size limit
  if (body.text.length > MAX_MESSAGE_SIZE) {
    return { ok: false, error: `Message too large (${body.text.length} chars, max ${MAX_MESSAGE_SIZE})` };
  }

  // Verify target exists (skip for virtual peers like dashboard/cli)
  if (!VIRTUAL_PEERS.has(body.to_id)) {
    const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
    if (!target) {
      return { ok: false, error: `Peer ${body.to_id} not found` };
    }

    // Group isolation check
    if (!canCommunicate(body.from_id, body.to_id)) {
      return { ok: false, error: "Cannot message peers in a different group" };
    }

    // Queue depth limit (only for real peers)
    const queueCount = countUndelivered.get(body.to_id) as { cnt: number };
    if (queueCount.cnt >= MAX_QUEUE_DEPTH) {
      return { ok: false, error: `Peer ${body.to_id} message queue is full (${MAX_QUEUE_DEPTH} undelivered)` };
    }
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString(), currentSessionId);
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered immediately to prevent duplicate sends
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleUnregister(body: { id: string }): void {
  db.run("DELETE FROM peer_groups WHERE peer_id = ?", [body.id]);
  activeFilesMap.delete(body.id);
  deletePeer.run(body.id);
}

function handleBroadcast(body: BroadcastRequest): BroadcastResponse {
  if (isRateLimited(body.from_id)) {
    return { ok: false, sent_to: 0, error: `Rate limited: max ${RATE_LIMIT_MAX} messages per minute` };
  }
  if (body.text.length > MAX_MESSAGE_SIZE) {
    return { ok: false, sent_to: 0, error: `Message too large (${body.text.length} chars, max ${MAX_MESSAGE_SIZE})` };
  }

  const targets = handleListPeers({
    scope: body.scope,
    cwd: body.cwd,
    git_root: body.git_root,
    exclude_id: body.from_id,
  });

  const now = new Date().toISOString();
  const insertMany = db.transaction(() => {
    for (const peer of targets) {
      insertMessage.run(body.from_id, peer.id, body.text, now, currentSessionId);
    }
  });
  insertMany();

  return { ok: true, sent_to: targets.length };
}

function handleAckMessage(body: AckMessageRequest): { ok: boolean; error?: string } {
  const msg = db.query("SELECT id, to_id FROM messages WHERE id = ?").get(body.message_id) as { id: number; to_id: string } | null;
  if (!msg) return { ok: false, error: "Message not found" };
  if (msg.to_id !== body.id) return { ok: false, error: "Not the recipient" };
  ackMessage.run(body.message_id, body.id);
  return { ok: true };
}

function handleCheckAcks(body: CheckAcksRequest): CheckAcksResponse {
  const messages = selectSentMessages.all(body.from_id, body.limit ?? 20) as Message[];
  return { messages };
}


// --- Isolation group management ---

function handleCreateIsolationGroup(body: { name: string }): { ok: boolean; id?: string; error?: string } {
  const name = body.name.trim();
  if (!name || name.length > 32) return { ok: false, error: "Group name must be 1-32 characters" };
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return { ok: false, error: "Group name can only contain letters, numbers, hyphens, and underscores" };

  const existing = db.query("SELECT id FROM isolation_groups WHERE name = ?").get(name);
  if (existing) return { ok: false, error: `Group "${name}" already exists` };

  const id = generateId();
  db.run("INSERT INTO isolation_groups (id, name, created_at) VALUES (?, ?, ?)", [id, name, new Date().toISOString()]);
  return { ok: true, id };
}

function handleAssignGroup(body: { peer_id: string; group_id: string | null }): { ok: boolean; error?: string } {
  const peer = db.query("SELECT id, name, group_id FROM peers WHERE id = ?").get(body.peer_id) as { id: string; name: string; group_id: string | null } | null;
  if (!peer) return { ok: false, error: "Peer not found" };

  if (body.group_id !== null) {
    const group = db.query("SELECT id FROM isolation_groups WHERE id = ?").get(body.group_id);
    if (!group) return { ok: false, error: "Group not found" };
  }

  const oldGroupId = peer.group_id;

  // Re-assign name within the new group's namespace — only for default claude-N names.
  // Custom names (set via set_name) are preserved across group moves.
  if (oldGroupId !== body.group_id && /^claude-\d+$/.test(peer.name)) {
    // Temporarily clear name so nextPeerName doesn't see the old name as occupied in the new group
    updateName.run("_reassigning", body.peer_id);
    db.run("UPDATE peers SET group_id = ? WHERE id = ?", [body.group_id, body.peer_id]);
    const newName = nextPeerName(body.group_id);
    updateName.run(newName, body.peer_id);
  } else {
    db.run("UPDATE peers SET group_id = ? WHERE id = ?", [body.group_id, body.peer_id]);
  }

  return { ok: true };
}

function handleDeleteIsolationGroup(body: { group_id: string }): { ok: boolean; error?: string } {
  const group = db.query("SELECT id FROM isolation_groups WHERE id = ?").get(body.group_id);
  if (!group) return { ok: false, error: "Group not found" };

  // Move all members back to lobby and rename them
  const members = db.query("SELECT id, name FROM peers WHERE group_id = ?").all(body.group_id) as { id: string; name: string }[];
  for (const m of members) {
    if (/^claude-\d+$/.test(m.name)) {
      updateName.run("_reassigning", m.id);
    }
    db.run("UPDATE peers SET group_id = NULL WHERE id = ?", [m.id]);
    if (/^claude-\d+$/.test(m.name)) {
      const newName = nextPeerName(null);
      updateName.run(newName, m.id);
    }
  }

  db.run("DELETE FROM isolation_groups WHERE id = ?", [body.group_id]);
  return { ok: true };
}

function handleListIsolationGroups(): { groups: Array<{ id: string; name: string; member_count: number; members: Array<{ id: string; name: string }> }> } {
  const groups = db.query("SELECT id, name FROM isolation_groups ORDER BY created_at ASC").all() as Array<{ id: string; name: string }>;
  return {
    groups: groups.map((g) => {
      const members = db.query("SELECT id, name FROM peers WHERE group_id = ?").all(g.id) as Array<{ id: string; name: string }>;
      return { id: g.id, name: g.name, member_count: members.length, members };
    }),
  };
}

function handleSetStatus(body: SetStatusRequest): { ok: boolean } {
  updateStatus.run(body.status, body.id);
  return { ok: true };
}

function handleSetTyping(body: { id: string }): { ok: boolean } {
  typingState.set(body.id, Date.now());
  return { ok: true };
}

// --- Feature: Message Pinning ---

function handlePinMessage(body: { message_id: number; pinned: boolean }): { ok: boolean; error?: string } {
  const msg = db.query("SELECT id FROM messages WHERE id = ?").get(body.message_id) as { id: number } | null;
  if (!msg) return { ok: false, error: "Message not found" };
  db.run("UPDATE messages SET pinned = ? WHERE id = ?", [body.pinned ? 1 : 0, body.message_id]);
  return { ok: true };
}

// --- Feature: Tasks ---

function handleCreateTask(body: { title: string; description?: string; creator_id: string; assignee_id?: string; group_id?: string | null }): { ok: boolean; id?: string; error?: string } {
  const title = body.title.trim();
  if (!title) return { ok: false, error: "Title cannot be empty" };
  if (title.length > 200) return { ok: false, error: "Title too long (max 200)" };

  // If assignee specified, verify they exist and are in same group
  if (body.assignee_id && !VIRTUAL_PEERS.has(body.assignee_id)) {
    const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.assignee_id);
    if (!target) return { ok: false, error: "Assignee not found" };
    if (!VIRTUAL_PEERS.has(body.creator_id) && !canCommunicate(body.creator_id, body.assignee_id)) {
      return { ok: false, error: "Cannot assign tasks to peers in a different group" };
    }
  }

  // Determine group from creator
  let groupId = body.group_id ?? null;
  if (!groupId && !VIRTUAL_PEERS.has(body.creator_id)) {
    groupId = getPeerGroupId(body.creator_id) ?? null;
  }

  const id = generateId();
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO tasks (id, title, description, creator_id, assignee_id, group_id, status, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    [id, title, body.description || "", body.creator_id, body.assignee_id || null, groupId, now, currentSessionId]
  );

  // If there's an assignee, send them a notification message
  if (body.assignee_id) {
    const creatorName = VIRTUAL_PEERS.has(body.creator_id)
      ? body.creator_id
      : ((db.query("SELECT name FROM peers WHERE id = ?").get(body.creator_id) as { name: string } | null)?.name || body.creator_id);
    insertMessage.run(
      body.creator_id, body.assignee_id,
      `**Task assigned to you:** ${title}${body.description ? `\n${body.description}` : ""}`,
      now, currentSessionId
    );
  }

  return { ok: true, id };
}

function handleCompleteTask(body: { task_id: string; peer_id: string; result?: string }): { ok: boolean; error?: string } {
  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(body.task_id) as any;
  if (!task) return { ok: false, error: "Task not found" };
  if (task.status === "completed") return { ok: false, error: "Task already completed" };

  const now = new Date().toISOString();
  db.run(
    "UPDATE tasks SET status = 'completed', result = ?, completed_at = ? WHERE id = ?",
    [body.result || "", now, body.task_id]
  );

  // Notify the creator
  if (task.creator_id && task.creator_id !== body.peer_id) {
    const peerName = VIRTUAL_PEERS.has(body.peer_id)
      ? body.peer_id
      : ((db.query("SELECT name FROM peers WHERE id = ?").get(body.peer_id) as { name: string } | null)?.name || body.peer_id);
    insertMessage.run(
      body.peer_id, task.creator_id,
      `**Task completed:** ${task.title}${body.result ? `\n**Result:** ${body.result}` : ""}`,
      now, currentSessionId
    );
  }

  return { ok: true };
}

function handleListTasks(body: { group_id?: string | null; peer_id?: string; status?: string }): { tasks: any[] } {
  let query = "SELECT * FROM tasks WHERE session_id = ?";
  const params: any[] = [currentSessionId];

  if (body.group_id !== undefined) {
    if (body.group_id === null) {
      query += " AND group_id IS NULL";
    } else {
      query += " AND group_id = ?";
      params.push(body.group_id);
    }
  }

  if (body.peer_id) {
    query += " AND (creator_id = ? OR assignee_id = ?)";
    params.push(body.peer_id, body.peer_id);
  }

  if (body.status) {
    query += " AND status = ?";
    params.push(body.status);
  }

  query += " ORDER BY created_at DESC LIMIT 100";
  return { tasks: db.query(query).all(...params) as any[] };
}

// --- Feature: Active Files (edit conflict detection) ---

function handleSetActiveFiles(body: { id: string; files: string[] }): { ok: boolean; conflicts?: Array<{ file: string; peer_id: string; peer_name: string }> } {
  const files = body.files.slice(0, 50); // cap at 50 files
  activeFilesMap.set(body.id, { files, updated_at: Date.now() });

  // Check for conflicts within same group
  const myGroup = getPeerGroupId(body.id);
  const conflicts: Array<{ file: string; peer_id: string; peer_name: string }> = [];
  const now = Date.now();

  for (const [peerId, data] of activeFilesMap) {
    if (peerId === body.id) continue;
    if (now - data.updated_at > ACTIVE_FILES_TIMEOUT_MS) { activeFilesMap.delete(peerId); continue; }

    const peerGroup = getPeerGroupId(peerId);
    if (myGroup !== peerGroup) continue; // different group, no conflict

    for (const file of files) {
      if (data.files.includes(file)) {
        const peerRow = db.query("SELECT name FROM peers WHERE id = ?").get(peerId) as { name: string } | null;
        conflicts.push({ file, peer_id: peerId, peer_name: peerRow?.name || peerId });
      }
    }
  }

  return { ok: true, conflicts: conflicts.length > 0 ? conflicts : undefined };
}

function getActiveFilesState(): Array<{ peer_id: string; peer_name: string; files: string[] }> {
  const now = Date.now();
  const result: Array<{ peer_id: string; peer_name: string; files: string[] }> = [];
  for (const [peerId, data] of activeFilesMap) {
    if (now - data.updated_at > ACTIVE_FILES_TIMEOUT_MS) { activeFilesMap.delete(peerId); continue; }
    const peerRow = db.query("SELECT name FROM peers WHERE id = ?").get(peerId) as { name: string } | null;
    result.push({ peer_id: peerId, peer_name: peerRow?.name || peerId, files: data.files });
  }
  return result;
}

function handleMessageHistory(body: MessageHistoryRequest): MessageHistoryResponse {
  // Enforce group isolation — peers in different groups cannot view each other's history
  if (!canCommunicate(body.peer_a, body.peer_b)) {
    return { messages: [] };
  }
  const limit = body.limit ?? 50;
  const messages = selectMessageHistory.all(
    body.peer_a, body.peer_b, body.peer_b, body.peer_a, currentSessionId, limit
  ) as Message[];
  return { messages };
}

function getDashboardState() {
  const peers = selectAllPeers.all() as Peer[];
  const messages = selectSessionMessages.all(currentSessionId) as Message[];
  const isolationGroups = handleListIsolationGroups().groups;
  // Build typing list (peers that signaled typing in last 5s)
  const now = Date.now();
  const typing: string[] = [];
  for (const [id, ts] of typingState) {
    if (now - ts < TYPING_TIMEOUT_MS) typing.push(id);
    else typingState.delete(id);
  }

  const tasks = db.query("SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 100").all(currentSessionId) as any[];
  const pinnedMessages = db.query("SELECT * FROM messages WHERE session_id = ? AND pinned = 1 ORDER BY sent_at ASC").all(currentSessionId) as Message[];
  const activeFiles = getActiveFilesState();

  return {
    peers,
    messages,
    groups: isolationGroups,
    typing,
    tasks,
    pinned: pinnedMessages,
    active_files: activeFiles,
    session_id: currentSessionId,
    uptime_ms: Date.now() - BROKER_START_TIME,
  };
}

// --- Dashboard ---

const DASHBOARD_PATH = new URL("./dashboard.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DASHBOARD_JS_PATH = new URL("./dashboard.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// --- WebSocket clients for dashboard ---

const dashboardClients = new Set<any>();

function broadcastDashboard() {
  if (dashboardClients.size === 0) return;
  const state = JSON.stringify(getDashboardState());
  for (const ws of dashboardClients) {
    try { ws.send(state); } catch { dashboardClients.delete(ws); }
  }
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // WebSocket upgrade for dashboard
    if (path === "/ws" && req.headers.get("upgrade") === "websocket") {
      const success = server.upgrade(req);
      return success ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (req.method === "GET") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      if (path === "/api/dashboard-state") {
        return Response.json(getDashboardState());
      }
      if (path === "/dashboard.js") {
        return new Response(Bun.file(DASHBOARD_JS_PATH), { headers: { "Content-Type": "application/javascript" } });
      }
      // Serve dashboard HTML for root path
      return new Response(Bun.file(DASHBOARD_PATH), { headers: { "Content-Type": "text/html" } });
    }

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(validateRegisterRequest(body)));
        case "/heartbeat":
          handleHeartbeat(validateHeartbeatRequest(body));
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(validateSetSummaryRequest(body));
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(validateListPeersRequest(body)));
        case "/send-message":
          return Response.json(handleSendMessage(validateSendMessageRequest(body)));
        case "/poll-messages":
          return Response.json(handlePollMessages(validatePollMessagesRequest(body)));
        case "/unregister":
          handleUnregister(validateUnregisterRequest(body));
          return Response.json({ ok: true });
        case "/broadcast":
          return Response.json(handleBroadcast(validateBroadcastRequest(body)));
        case "/ack-message":
          return Response.json(handleAckMessage(validateAckMessageRequest(body)));
        case "/check-acks":
          return Response.json(handleCheckAcks(validateCheckAcksRequest(body)));
        case "/create-group": {
          const b = validateBody(body);
          return Response.json(handleCreateIsolationGroup({ name: validateString(b.name, "name") }));
        }
        case "/assign-group": {
          const b = validateBody(body);
          const peerId = validateString(b.peer_id, "peer_id");
          const groupId = b.group_id === null || b.group_id === undefined ? null : validateString(b.group_id, "group_id");
          return Response.json(handleAssignGroup({ peer_id: peerId, group_id: groupId }));
        }
        case "/delete-group": {
          const b = validateBody(body);
          return Response.json(handleDeleteIsolationGroup({ group_id: validateString(b.group_id, "group_id") }));
        }
        case "/list-isolation-groups":
          return Response.json(handleListIsolationGroups());
        case "/set-name":
          return Response.json(handleSetName(validateSetNameRequest(body)));
        case "/set-status":
          return Response.json(handleSetStatus(validateSetStatusRequest(body)));
        case "/set-typing":
          return Response.json(handleSetTyping(validateSetTypingRequest(body)));
        case "/message-history":
          return Response.json(handleMessageHistory(validateMessageHistoryRequest(body)));
        case "/pin-message": {
          const b = validateBody(body);
          return Response.json(handlePinMessage({
            message_id: validateNumber(b.message_id, "message_id"),
            pinned: b.pinned !== false,
          }));
        }
        case "/create-task": {
          const b = validateBody(body);
          return Response.json(handleCreateTask({
            title: validateString(b.title, "title"),
            description: typeof b.description === "string" ? b.description : "",
            creator_id: validateString(b.creator_id, "creator_id"),
            assignee_id: typeof b.assignee_id === "string" ? b.assignee_id : undefined,
            group_id: b.group_id === null ? null : typeof b.group_id === "string" ? b.group_id : undefined,
          }));
        }
        case "/complete-task": {
          const b = validateBody(body);
          return Response.json(handleCompleteTask({
            task_id: validateString(b.task_id, "task_id"),
            peer_id: validateString(b.peer_id, "peer_id"),
            result: typeof b.result === "string" ? b.result : undefined,
          }));
        }
        case "/list-tasks": {
          const b = validateBody(body);
          return Response.json(handleListTasks({
            group_id: b.group_id === null ? null : typeof b.group_id === "string" ? b.group_id : undefined,
            peer_id: typeof b.peer_id === "string" ? b.peer_id : undefined,
            status: typeof b.status === "string" ? b.status : undefined,
          }));
        }
        case "/set-active-files": {
          const b = validateBody(body);
          const files = Array.isArray(b.files) ? b.files.filter((f: unknown) => typeof f === "string") : [];
          return Response.json(handleSetActiveFiles({ id: validateString(b.id, "id"), files }));
        }
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const isValidation = e instanceof ValidationError;
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: isValidation ? 400 : 500 });
    } finally {
      // Push state to all dashboard WebSocket clients after any POST
      if (req.method === "POST") broadcastDashboard();
    }
  },
  websocket: {
    open(ws: any) {
      dashboardClients.add(ws);
      ws.send(JSON.stringify(getDashboardState()));
    },
    message(_ws: any, _message: any) {
      // Dashboard doesn't send messages via WS, only receives
    },
    close(ws: any) {
      dashboardClients.delete(ws);
    },
  },
});

const log = createLogger("broker");
log.info(`listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
