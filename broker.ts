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
  JoinGroupRequest,
  LeaveGroupRequest,
  SendToGroupRequest,
  SendToGroupResponse,
  ListGroupsResponse,
  SetNameRequest,
  SetStatusRequest,
  MessageHistoryRequest,
  MessageHistoryResponse,
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${homedir()}/.claude-peers.db`;

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

// Performance indices
db.run("CREATE INDEX IF NOT EXISTS idx_messages_to_delivered ON messages(to_id, delivered)");
db.run("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at)");

const BROKER_START_TIME = Date.now();

// --- Session tracking ---
let currentSessionId = crypto.randomUUID();

// Typing indicators (in-memory, not persisted)
const typingState = new Map<string, number>();
const TYPING_TIMEOUT_MS = 5000;

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks)
      process.kill(peer.pid, 0);
    } catch {
      // Process doesn't exist, remove it
      db.run("DELETE FROM peer_groups WHERE peer_id = ?", [peer.id]);
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }

}

// NOTE: initial cleanStalePeers() and setInterval are called after rateLimitMap is defined below

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, name, pid, cwd, git_root, tty, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

const joinGroup = db.prepare(`
  INSERT OR IGNORE INTO peer_groups (peer_id, group_name, joined_at) VALUES (?, ?, ?)
`);

const leaveGroup = db.prepare(`
  DELETE FROM peer_groups WHERE peer_id = ? AND group_name = ?
`);

const selectGroupMembers = db.prepare(`
  SELECT p.* FROM peers p JOIN peer_groups pg ON p.id = pg.peer_id WHERE pg.group_name = ?
`);

const selectAllGroups = db.prepare(`
  SELECT group_name, COUNT(*) as member_count FROM peer_groups GROUP BY group_name
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

function validateRegisterRequest(raw: unknown): RegisterRequest {
  const b = validateBody(raw);
  return {
    pid: validateNumber(b.pid, "pid"),
    cwd: validateString(b.cwd, "cwd"),
    git_root: validateOptionalString(b.git_root, "git_root"),
    tty: validateOptionalString(b.tty, "tty"),
    summary: typeof b.summary === "string" ? b.summary : "",
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

function validateJoinGroupRequest(raw: unknown): JoinGroupRequest {
  const b = validateBody(raw);
  return {
    id: validateString(b.id, "id"),
    group: validateString(b.group, "group"),
  };
}

function validateLeaveGroupRequest(raw: unknown): LeaveGroupRequest {
  const b = validateBody(raw);
  return {
    id: validateString(b.id, "id"),
    group: validateString(b.group, "group"),
  };
}

function validateSendToGroupRequest(raw: unknown): SendToGroupRequest {
  const b = validateBody(raw);
  return {
    from_id: validateString(b.from_id, "from_id"),
    group: validateString(b.group, "group"),
    text: validateString(b.text, "text"),
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

// --- Auto-naming ---

function nextPeerName(): string {
  const row = db.query("SELECT name FROM peers WHERE name LIKE 'claude-%' ORDER BY CAST(SUBSTR(name, 8) AS INTEGER) DESC LIMIT 1").get() as { name: string } | null;
  if (!row) return "claude-1";
  const num = parseInt(row.name.slice(7), 10);
  return `claude-${(isNaN(num) ? 0 : num) + 1}`;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const name = nextPeerName();
  const now = new Date().toISOString();

  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    db.run("DELETE FROM peer_groups WHERE peer_id = ?", [existing.id]);
    deletePeer.run(existing.id);
  }

  // Start a new session if no peers currently exist
  const peerCount = (db.query("SELECT COUNT(*) as cnt FROM peers").get() as { cnt: number }).cnt;
  if (peerCount === 0) {
    currentSessionId = crypto.randomUUID();
  }

  insertPeer.run(id, name, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now);
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

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      // Clean up dead peer
      deletePeer.run(p.id);
      return false;
    }
  });
}

// Virtual peers (dashboard UI, CLI) — not in the peers table but can receive messages
const VIRTUAL_PEERS = new Set(["dashboard", "cli"]);

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

function handleJoinGroup(body: JoinGroupRequest): { ok: boolean } {
  joinGroup.run(body.id, body.group, new Date().toISOString());
  return { ok: true };
}

function handleLeaveGroup(body: LeaveGroupRequest): { ok: boolean } {
  leaveGroup.run(body.id, body.group);
  return { ok: true };
}

function handleSendToGroup(body: SendToGroupRequest): SendToGroupResponse {
  if (isRateLimited(body.from_id)) {
    return { ok: false, sent_to: 0, error: `Rate limited: max ${RATE_LIMIT_MAX} messages per minute` };
  }
  if (body.text.length > MAX_MESSAGE_SIZE) {
    return { ok: false, sent_to: 0, error: `Message too large` };
  }

  const members = (selectGroupMembers.all(body.group) as Peer[]).filter((p) => {
    if (p.id === body.from_id) return false;
    try { process.kill(p.pid, 0); return true; } catch { deletePeer.run(p.id); return false; }
  });

  const now = new Date().toISOString();
  const insertMany = db.transaction(() => {
    for (const peer of members) {
      insertMessage.run(body.from_id, peer.id, body.text, now, currentSessionId);
    }
  });
  insertMany();

  return { ok: true, sent_to: members.length };
}

function handleListGroups(): ListGroupsResponse {
  const groups = selectAllGroups.all() as Array<{ group_name: string; member_count: number }>;
  return { groups: groups.map((g) => ({ name: g.group_name, member_count: g.member_count })) };
}

function handleSetStatus(body: SetStatusRequest): { ok: boolean } {
  updateStatus.run(body.status, body.id);
  return { ok: true };
}

function handleSetTyping(body: { id: string }): { ok: boolean } {
  typingState.set(body.id, Date.now());
  return { ok: true };
}

function handleMessageHistory(body: MessageHistoryRequest): MessageHistoryResponse {
  const limit = body.limit ?? 50;
  const messages = selectMessageHistory.all(
    body.peer_a, body.peer_b, body.peer_b, body.peer_a, currentSessionId, limit
  ) as Message[];
  return { messages };
}

function getDashboardState() {
  const peers = selectAllPeers.all() as Peer[];
  const messages = selectSessionMessages.all(currentSessionId) as Message[];
  const groups = selectAllGroups.all() as Array<{ group_name: string; member_count: number }>;
  // Build typing list (peers that signaled typing in last 5s)
  const now = Date.now();
  const typing: string[] = [];
  for (const [id, ts] of typingState) {
    if (now - ts < TYPING_TIMEOUT_MS) typing.push(id);
    else typingState.delete(id);
  }

  return {
    peers,
    messages,
    groups: groups.map((g) => ({ name: g.group_name, member_count: g.member_count })),
    typing,
    session_id: currentSessionId,
    uptime_ms: Date.now() - BROKER_START_TIME,
  };
}

// --- Dashboard ---

const DASHBOARD_PATH = new URL("./dashboard.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

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
        case "/join-group":
          return Response.json(handleJoinGroup(validateJoinGroupRequest(body)));
        case "/leave-group":
          return Response.json(handleLeaveGroup(validateLeaveGroupRequest(body)));
        case "/send-to-group":
          return Response.json(handleSendToGroup(validateSendToGroupRequest(body)));
        case "/list-groups":
          return Response.json(handleListGroups());
        case "/set-name":
          return Response.json(handleSetName(validateSetNameRequest(body)));
        case "/set-status":
          return Response.json(handleSetStatus(validateSetStatusRequest(body)));
        case "/set-typing":
          return Response.json(handleSetTyping(validateSetTypingRequest(body)));
        case "/message-history":
          return Response.json(handleMessageHistory(validateMessageHistoryRequest(body)));
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
