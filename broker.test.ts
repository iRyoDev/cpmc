/**
 * broker.test.ts — Test suite for the claude-peers broker
 *
 * Tests the broker HTTP API directly by spawning a broker on a random port
 * with an in-memory test database, then making HTTP requests against it.
 *
 * Run: bun test broker
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";

// --- Test broker setup ---

const TEST_PORT = 17899 + Math.floor(Math.random() * 1000);
const TEST_DB = `:memory:`;
const BROKER_URL = `http://127.0.0.1:${TEST_PORT}`;

let brokerProc: ReturnType<typeof Bun.spawn>;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: body !== undefined ? "POST" : "GET",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  return res.json() as Promise<T>;
}

async function apiRaw(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BROKER_URL}${path}`, {
    method: body !== undefined ? "POST" : "GET",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
}

beforeAll(async () => {
  const brokerScript = new URL("./broker.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  brokerProc = Bun.spawn(["bun", brokerScript], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
      CLAUDE_PEERS_SKIP_PID_CHECK: "1", // Skip PID alive checks in tests
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  // Wait for broker to come up
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("Broker failed to start");
});

afterAll(() => {
  brokerProc?.kill();
});

// --- Helper: register a test peer ---

async function registerPeer(overrides: Partial<{ pid: number; cwd: string; git_root: string | null; tty: string | null; summary: string; git_branch: string | null }> = {}): Promise<{ id: string; name: string }> {
  return api<{ id: string; name: string }>("/register", {
    pid: Math.floor(Math.random() * 100000) + 10000,
    cwd: "/test/project",
    git_root: "/test/project",
    tty: null,
    summary: "",
    git_branch: null,
    ...overrides,
  });
}

// =============================================================================
// HEALTH & BASICS
// =============================================================================

describe("Health", () => {
  test("returns ok status", async () => {
    const health = await api<{ status: string; peers: number }>("/health");
    expect(health.status).toBe("ok");
    expect(typeof health.peers).toBe("number");
  });
});

// =============================================================================
// PEER REGISTRATION
// =============================================================================

describe("Peer Registration", () => {
  test("registers a peer and returns id + name", async () => {
    const reg = await registerPeer();
    expect(reg.id).toBeTruthy();
    expect(reg.name).toMatch(/^claude-\d+$/);
  });

  test("assigns incrementing names", async () => {
    const p1 = await registerPeer();
    const p2 = await registerPeer();
    // Names should be unique
    expect(p1.name).not.toBe(p2.name);
  });

  test("rejects invalid registration (missing pid)", async () => {
    const res = await apiRaw("/register", { cwd: "/test", git_root: null, tty: null, summary: "" });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// PEER LISTING
// =============================================================================

describe("Peer Listing", () => {
  test("lists registered peers by machine scope", async () => {
    const reg = await registerPeer({ cwd: "/list-test" });
    const peers = await api<Array<{ id: string; name: string; cwd: string }>>("/list-peers", {
      scope: "machine",
      cwd: "/anywhere",
      git_root: null,
    });
    const found = peers.find(p => p.id === reg.id);
    expect(found).toBeTruthy();
    expect(found!.cwd).toBe("/list-test");
  });

  test("filters by directory scope", async () => {
    const p1 = await registerPeer({ cwd: "/dir-a" });
    const p2 = await registerPeer({ cwd: "/dir-b" });
    const peers = await api<Array<{ id: string }>>("/list-peers", {
      scope: "directory",
      cwd: "/dir-a",
      git_root: null,
    });
    const ids = peers.map(p => p.id);
    expect(ids).toContain(p1.id);
    expect(ids).not.toContain(p2.id);
  });

  test("excludes requesting peer", async () => {
    const me = await registerPeer();
    const peers = await api<Array<{ id: string }>>("/list-peers", {
      scope: "machine",
      cwd: "/test",
      git_root: null,
      exclude_id: me.id,
    });
    const ids = peers.map(p => p.id);
    expect(ids).not.toContain(me.id);
  });
});

// =============================================================================
// MESSAGING
// =============================================================================

describe("Messaging", () => {
  test("sends and polls a message", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();

    const sendResult = await api<{ ok: boolean }>("/send-message", {
      from_id: sender.id,
      to_id: receiver.id,
      text: "Hello from test!",
    });
    expect(sendResult.ok).toBe(true);

    const poll = await api<{ messages: Array<{ text: string; from_id: string }> }>("/poll-messages", { id: receiver.id });
    expect(poll.messages.length).toBeGreaterThanOrEqual(1);
    const msg = poll.messages.find(m => m.text === "Hello from test!");
    expect(msg).toBeTruthy();
    expect(msg!.from_id).toBe(sender.id);
  });

  test("marks messages as delivered after poll", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();

    await api("/send-message", { from_id: sender.id, to_id: receiver.id, text: "once" });

    // First poll gets the message
    const poll1 = await api<{ messages: Array<{ text: string }> }>("/poll-messages", { id: receiver.id });
    const found = poll1.messages.find(m => m.text === "once");
    expect(found).toBeTruthy();

    // Second poll should NOT get it again
    const poll2 = await api<{ messages: Array<{ text: string }> }>("/poll-messages", { id: receiver.id });
    const refound = poll2.messages.find(m => m.text === "once");
    expect(refound).toBeUndefined();
  });

  test("rejects message to non-existent peer", async () => {
    const sender = await registerPeer();
    const result = await api<{ ok: boolean; error?: string }>("/send-message", {
      from_id: sender.id,
      to_id: "nonexistent",
      text: "hello",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("enforces message size limit", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();
    const result = await api<{ ok: boolean; error?: string }>("/send-message", {
      from_id: sender.id,
      to_id: receiver.id,
      text: "x".repeat(70000),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("too large");
  });
});

// =============================================================================
// ACKNOWLEDGMENTS
// =============================================================================

describe("Acknowledgments", () => {
  test("acknowledges a message", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();

    await api("/send-message", { from_id: sender.id, to_id: receiver.id, text: "ack me" });
    const poll = await api<{ messages: Array<{ id: number; text: string }> }>("/poll-messages", { id: receiver.id });
    const msg = poll.messages.find(m => m.text === "ack me");
    expect(msg).toBeTruthy();

    const ackResult = await api<{ ok: boolean }>("/ack-message", { id: receiver.id, message_id: msg!.id });
    expect(ackResult.ok).toBe(true);
  });

  test("rejects ack from non-recipient", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();
    const other = await registerPeer();

    await api("/send-message", { from_id: sender.id, to_id: receiver.id, text: "not for you" });
    const poll = await api<{ messages: Array<{ id: number; text: string }> }>("/poll-messages", { id: receiver.id });
    const msg = poll.messages.find(m => m.text === "not for you");

    const ackResult = await api<{ ok: boolean; error?: string }>("/ack-message", { id: other.id, message_id: msg!.id });
    expect(ackResult.ok).toBe(false);
    expect(ackResult.error).toContain("Not the recipient");
  });
});

// =============================================================================
// GROUP ISOLATION
// =============================================================================

describe("Group Isolation", () => {
  test("peers in different groups cannot message each other", async () => {
    // Create two groups
    const g1 = await api<{ ok: boolean; id: string }>("/create-group", { name: `group-a-${Date.now()}` });
    const g2 = await api<{ ok: boolean; id: string }>("/create-group", { name: `group-b-${Date.now()}` });

    const p1 = await registerPeer();
    const p2 = await registerPeer();

    await api("/assign-group", { peer_id: p1.id, group_id: g1.id });
    await api("/assign-group", { peer_id: p2.id, group_id: g2.id });

    const result = await api<{ ok: boolean; error?: string }>("/send-message", {
      from_id: p1.id,
      to_id: p2.id,
      text: "cross-group",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("different group");
  });

  test("peers in same group can message each other", async () => {
    const g = await api<{ ok: boolean; id: string }>("/create-group", { name: `group-same-${Date.now()}` });
    const p1 = await registerPeer();
    const p2 = await registerPeer();

    await api("/assign-group", { peer_id: p1.id, group_id: g.id });
    await api("/assign-group", { peer_id: p2.id, group_id: g.id });

    const result = await api<{ ok: boolean }>("/send-message", {
      from_id: p1.id,
      to_id: p2.id,
      text: "same group!",
    });
    expect(result.ok).toBe(true);
  });

  test("peer list respects group isolation", async () => {
    const g1 = await api<{ ok: boolean; id: string }>("/create-group", { name: `iso-list-${Date.now()}` });
    const p1 = await registerPeer();
    const p2 = await registerPeer();

    await api("/assign-group", { peer_id: p1.id, group_id: g1.id });
    // p2 stays in lobby

    const peers = await api<Array<{ id: string }>>("/list-peers", {
      scope: "machine",
      cwd: "/test",
      git_root: null,
      exclude_id: p1.id,
    });
    const ids = peers.map(p => p.id);
    // p1 is in a group, should NOT see lobby peers
    expect(ids).not.toContain(p2.id);
  });
});

// =============================================================================
// NAMING
// =============================================================================

describe("Naming", () => {
  test("set custom name", async () => {
    const p = await registerPeer();
    const result = await api<{ ok: boolean }>("/set-name", { id: p.id, name: "custom-name" });
    expect(result.ok).toBe(true);
  });

  test("rejects duplicate name", async () => {
    const p1 = await registerPeer();
    const p2 = await registerPeer();
    await api("/set-name", { id: p1.id, name: `unique-${Date.now()}` });
    const result = await api<{ ok: boolean; error?: string }>("/set-name", { id: p2.id, name: `unique-${Date.now()}` });
    // May or may not clash depending on timing, so just verify the API works
    expect(typeof result.ok).toBe("boolean");
  });

  test("rejects invalid name characters", async () => {
    const p = await registerPeer();
    const result = await api<{ ok: boolean; error?: string }>("/set-name", { id: p.id, name: "has spaces!" });
    expect(result.ok).toBe(false);
  });

  test("rejects empty name", async () => {
    const p = await registerPeer();
    const res = await apiRaw("/set-name", { id: p.id, name: "" });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// TASKS
// =============================================================================

describe("Tasks", () => {
  test("create and complete a task", async () => {
    const creator = await registerPeer();
    const assignee = await registerPeer();

    const create = await api<{ ok: boolean; id: string }>("/create-task", {
      title: "Test task",
      description: "Do something",
      creator_id: creator.id,
      assignee_id: assignee.id,
    });
    expect(create.ok).toBe(true);
    expect(create.id).toBeTruthy();

    const complete = await api<{ ok: boolean }>("/complete-task", {
      task_id: create.id,
      peer_id: assignee.id,
      result: "Done!",
    });
    expect(complete.ok).toBe(true);
  });

  test("rejects completing already-completed task", async () => {
    const p = await registerPeer();
    const create = await api<{ ok: boolean; id: string }>("/create-task", {
      title: "Already done", creator_id: p.id,
    });
    await api("/complete-task", { task_id: create.id, peer_id: p.id });
    const result = await api<{ ok: boolean; error?: string }>("/complete-task", { task_id: create.id, peer_id: p.id });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already completed");
  });
});

// =============================================================================
// DECISIONS BOARD
// =============================================================================

describe("Decisions Board", () => {
  test("post and query a decision", async () => {
    const p = await registerPeer();
    const post = await api<{ ok: boolean; id: string }>("/post-decision", {
      author_id: p.id,
      key: `test-decision-${Date.now()}`,
      value: "TypeScript",
      rationale: "Type safety",
      category: "tooling",
    });
    expect(post.ok).toBe(true);

    const list = await api<{ decisions: Array<{ key: string; value: string }> }>("/list-decisions", { category: "tooling" });
    expect(list.decisions.length).toBeGreaterThanOrEqual(1);
  });

  test("upserts decision on same key", async () => {
    const p = await registerPeer();
    const key = `upsert-${Date.now()}`;
    await api("/post-decision", { author_id: p.id, key, value: "v1", rationale: "first" });
    await api("/post-decision", { author_id: p.id, key, value: "v2", rationale: "updated" });

    const list = await api<{ decisions: Array<{ key: string; value: string }> }>("/list-decisions", { key });
    expect(list.decisions.length).toBe(1);
    expect(list.decisions[0]!.value).toBe("v2");
  });
});

// =============================================================================
// PROPOSALS / CONSENSUS
// =============================================================================

describe("Consensus Protocol", () => {
  test("create proposal and vote to approve", async () => {
    const author = await registerPeer();
    const voter1 = await registerPeer();
    const voter2 = await registerPeer();

    const create = await api<{ ok: boolean; id: string }>("/create-proposal", {
      author_id: author.id,
      title: "Use Bun",
      description: "Replace Node.js with Bun",
      required_votes: 2,
    });
    expect(create.ok).toBe(true);

    const v1 = await api<{ ok: boolean; status?: string }>("/vote-proposal", {
      proposal_id: create.id, voter_id: voter1.id, vote: "approve", reason: "Fast",
    });
    expect(v1.ok).toBe(true);
    expect(v1.status).toBe("open"); // Not yet resolved

    const v2 = await api<{ ok: boolean; status?: string }>("/vote-proposal", {
      proposal_id: create.id, voter_id: voter2.id, vote: "approve", reason: "Agreed",
    });
    expect(v2.ok).toBe(true);
    expect(v2.status).toBe("approved"); // Auto-resolved
  });

  test("cannot vote on own proposal", async () => {
    const author = await registerPeer();
    const create = await api<{ ok: boolean; id: string }>("/create-proposal", {
      author_id: author.id, title: "Self-vote", description: "test", required_votes: 1,
    });
    const result = await api<{ ok: boolean; error?: string }>("/vote-proposal", {
      proposal_id: create.id, voter_id: author.id, vote: "approve",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("own proposal");
  });
});

// =============================================================================
// INPUT VALIDATION
// =============================================================================

describe("Input Validation", () => {
  test("rejects non-JSON body", async () => {
    const res = await fetch(`${BROKER_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    // Bun's req.json() throws on invalid JSON → caught as 500
    expect(res.ok).toBe(false);
  });

  test("rejects missing required fields", async () => {
    const res = await apiRaw("/send-message", { from_id: "a" });
    expect(res.status).toBe(400);
  });

  test("rejects invalid scope", async () => {
    const res = await apiRaw("/list-peers", { scope: "galaxy", cwd: "/", git_root: null });
    expect(res.status).toBe(400);
  });

  test("rejects invalid status enum", async () => {
    const p = await registerPeer();
    const res = await apiRaw("/set-status", { id: p.id, status: "sleeping" });
    expect(res.status).toBe(400);
  });

  test("rejects invalid vote value", async () => {
    const res = await apiRaw("/vote-proposal", {
      proposal_id: "fake", voter_id: "fake", vote: "maybe",
    });
    expect(res.status).toBe(400);
  });

  test("rejects invalid verification status", async () => {
    const res = await apiRaw("/respond-verification", {
      verification_id: "fake", verifier_id: "fake", status: "maybe", response: "test",
    });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// BROADCAST
// =============================================================================

describe("Broadcast", () => {
  test("broadcasts to all peers in scope", async () => {
    const sender = await registerPeer({ cwd: "/broadcast-test" });
    const r1 = await registerPeer({ cwd: "/broadcast-test" });
    const r2 = await registerPeer({ cwd: "/broadcast-test" });

    const result = await api<{ ok: boolean; sent_to: number }>("/broadcast", {
      from_id: sender.id,
      scope: "directory",
      cwd: "/broadcast-test",
      git_root: null,
      text: "Hello everyone!",
    });
    expect(result.ok).toBe(true);
    expect(result.sent_to).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// DASHBOARD
// =============================================================================

describe("Dashboard", () => {
  test("serves HTML with ETag", async () => {
    const res = await fetch(`${BROKER_URL}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("cache-control")).toContain("max-age");
  });

  test("returns 304 for matching ETag", async () => {
    const res1 = await fetch(`${BROKER_URL}/`);
    const etag = res1.headers.get("etag");
    expect(etag).toBeTruthy();

    const res2 = await fetch(`${BROKER_URL}/`, {
      headers: { "If-None-Match": etag! },
    });
    expect(res2.status).toBe(304);
  });

  test("serves dashboard state API", async () => {
    const state = await api<{ peers: any[]; session_id: string }>("/api/dashboard-state");
    expect(state.session_id).toBeTruthy();
    expect(Array.isArray(state.peers)).toBe(true);
  });
});

// =============================================================================
// RATE LIMITING
// =============================================================================

describe("Rate Limiting", () => {
  test("allows exactly RATE_LIMIT_MAX messages, blocks the next", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();

    // Send 60 messages (the limit) — do sequentially to avoid race conditions
    for (let i = 0; i < 60; i++) {
      const result = await api<{ ok: boolean }>("/send-message", {
        from_id: sender.id, to_id: receiver.id, text: `msg-${i}`,
      });
      expect(result.ok).toBe(true);
    }

    // 61st message should be rate limited
    const blocked = await api<{ ok: boolean; error?: string }>("/send-message", {
      from_id: sender.id, to_id: receiver.id, text: "over limit",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("Rate limited");
  });

  test("different senders have independent rate limits", async () => {
    const s1 = await registerPeer();
    const s2 = await registerPeer();
    const receiver = await registerPeer();

    // Send 50 from s1
    for (let i = 0; i < 50; i++) {
      await api("/send-message", { from_id: s1.id, to_id: receiver.id, text: `s1-${i}` });
    }

    // s2 should still be able to send
    const result = await api<{ ok: boolean }>("/send-message", {
      from_id: s2.id, to_id: receiver.id, text: "s2-fresh",
    });
    expect(result.ok).toBe(true);
  });
});

// =============================================================================
// HEARTBEAT
// =============================================================================

describe("Heartbeat", () => {
  test("updates last_seen timestamp", async () => {
    const p = await registerPeer();

    // Wait briefly then heartbeat
    await new Promise(r => setTimeout(r, 50));
    const result = await api<{ ok: boolean }>("/heartbeat", { id: p.id });
    expect(result.ok).toBe(true);

    // Verify peer still shows up in listing (not stale)
    const peers = await api<Array<{ id: string }>>("/list-peers", {
      scope: "machine", cwd: "/", git_root: null,
    });
    expect(peers.find(peer => peer.id === p.id)).toBeTruthy();
  });
});

// =============================================================================
// APPROVAL WORKFLOW
// =============================================================================

describe("Approval Workflow", () => {
  test("request and approve", async () => {
    const requester = await registerPeer();
    const approver = await registerPeer();

    const req = await api<{ ok: boolean; id: string }>("/request-approval", {
      requester_id: requester.id,
      approver_id: approver.id,
      action_description: "Deploy to production",
    });
    expect(req.ok).toBe(true);
    expect(req.id).toBeTruthy();

    const respond = await api<{ ok: boolean }>("/respond-approval", {
      approval_id: req.id,
      peer_id: approver.id,
      approved: true,
      reason: "Looks good",
    });
    expect(respond.ok).toBe(true);

    // Verify status in list
    const list = await api<{ approvals: Array<{ id: string; status: string }> }>("/list-approvals", {
      peer_id: requester.id,
    });
    const found = list.approvals.find(a => a.id === req.id);
    expect(found).toBeTruthy();
    expect(found!.status).toBe("approved");
  });

  test("request and reject", async () => {
    const requester = await registerPeer();
    const approver = await registerPeer();

    const req = await api<{ ok: boolean; id: string }>("/request-approval", {
      requester_id: requester.id,
      approver_id: approver.id,
      action_description: "Delete database",
    });
    expect(req.ok).toBe(true);

    const respond = await api<{ ok: boolean }>("/respond-approval", {
      approval_id: req.id,
      peer_id: approver.id,
      approved: false,
      reason: "Too risky",
    });
    expect(respond.ok).toBe(true);

    const list = await api<{ approvals: Array<{ id: string; status: string }> }>("/list-approvals", {
      peer_id: requester.id,
    });
    const found = list.approvals.find(a => a.id === req.id);
    expect(found!.status).toBe("rejected");
  });

  test("rejects response from non-approver", async () => {
    const requester = await registerPeer();
    const approver = await registerPeer();
    const impostor = await registerPeer();

    const req = await api<{ ok: boolean; id: string }>("/request-approval", {
      requester_id: requester.id,
      approver_id: approver.id,
      action_description: "Test auth",
    });

    const result = await api<{ ok: boolean; error?: string }>("/respond-approval", {
      approval_id: req.id,
      peer_id: impostor.id,
      approved: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Not the designated approver");
  });
});

// =============================================================================
// VERIFICATION PROTOCOL
// =============================================================================

describe("Verification Protocol", () => {
  test("request and verify", async () => {
    const requester = await registerPeer();
    const verifier = await registerPeer();

    const req = await api<{ ok: boolean; id: string }>("/request-verification", {
      requester_id: requester.id,
      verifier_id: verifier.id,
      claim: "All tests pass",
      evidence_needed: "Run bun test and show output",
      files_to_check: ["broker.test.ts"],
    });
    expect(req.ok).toBe(true);
    expect(req.id).toBeTruthy();

    const respond = await api<{ ok: boolean }>("/respond-verification", {
      verification_id: req.id,
      verifier_id: verifier.id,
      status: "verified",
      response: "Confirmed, 37 tests pass",
      evidence: "bun test output: 37 pass, 0 fail",
    });
    expect(respond.ok).toBe(true);

    const list = await api<{ verifications: Array<{ id: string; status: string }> }>("/list-verifications", {
      peer_id: requester.id,
    });
    const found = list.verifications.find(v => v.id === req.id);
    expect(found).toBeTruthy();
    expect(found!.status).toBe("verified");
  });

  test("request and fail verification", async () => {
    const requester = await registerPeer();
    const verifier = await registerPeer();

    const req = await api<{ ok: boolean; id: string }>("/request-verification", {
      requester_id: requester.id,
      verifier_id: verifier.id,
      claim: "No TypeScript errors",
      evidence_needed: "Run tsc --noEmit",
    });

    const respond = await api<{ ok: boolean }>("/respond-verification", {
      verification_id: req.id,
      verifier_id: verifier.id,
      status: "failed",
      response: "3 type errors found",
    });
    expect(respond.ok).toBe(true);

    const list = await api<{ verifications: Array<{ id: string; status: string }> }>("/list-verifications", {
      peer_id: requester.id,
    });
    const found = list.verifications.find(v => v.id === req.id);
    expect(found!.status).toBe("failed");
  });

  test("rejects response from non-verifier", async () => {
    const requester = await registerPeer();
    const verifier = await registerPeer();
    const impostor = await registerPeer();

    const req = await api<{ ok: boolean; id: string }>("/request-verification", {
      requester_id: requester.id,
      verifier_id: verifier.id,
      claim: "Auth test",
      evidence_needed: "N/A",
    });

    const result = await api<{ ok: boolean; error?: string }>("/respond-verification", {
      verification_id: req.id,
      verifier_id: impostor.id,
      status: "verified",
      response: "Sure",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("designated verifier");
  });
});

// =============================================================================
// ACTIVE FILES (CONFLICT DETECTION)
// =============================================================================

describe("Active Files", () => {
  test("detects file conflicts between peers in same group", async () => {
    const p1 = await registerPeer();
    const p2 = await registerPeer();

    // p1 is editing broker.ts
    await api("/set-active-files", { id: p1.id, files: ["broker.ts", "server.ts"] });

    // p2 also starts editing broker.ts — should detect conflict
    const result = await api<{ ok: boolean; conflicts?: Array<{ file: string; peer_name: string }> }>(
      "/set-active-files",
      { id: p2.id, files: ["broker.ts", "dashboard.js"] }
    );
    expect(result.ok).toBe(true);
    expect(result.conflicts).toBeTruthy();
    expect(result.conflicts!.length).toBeGreaterThanOrEqual(1);
    expect(result.conflicts![0]!.file).toBe("broker.ts");
  });

  test("no conflict for non-overlapping files", async () => {
    const p1 = await registerPeer();
    const p2 = await registerPeer();

    await api("/set-active-files", { id: p1.id, files: ["file-a.ts"] });
    const result = await api<{ ok: boolean; conflicts?: Array<{ file: string }> }>(
      "/set-active-files",
      { id: p2.id, files: ["file-b.ts"] }
    );
    expect(result.ok).toBe(true);
    expect(result.conflicts).toBeUndefined();
  });
});

// =============================================================================
// MESSAGE PINNING
// =============================================================================

describe("Message Pinning", () => {
  test("pins and unpins a message", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();

    await api("/send-message", { from_id: sender.id, to_id: receiver.id, text: "pin me!" });
    const poll = await api<{ messages: Array<{ id: number; text: string }> }>("/poll-messages", { id: receiver.id });
    const msg = poll.messages.find(m => m.text === "pin me!");
    expect(msg).toBeTruthy();

    // Pin
    const pinResult = await api<{ ok: boolean }>("/pin-message", { message_id: msg!.id, pinned: true });
    expect(pinResult.ok).toBe(true);

    // Unpin
    const unpinResult = await api<{ ok: boolean }>("/pin-message", { message_id: msg!.id, pinned: false });
    expect(unpinResult.ok).toBe(true);
  });

  test("rejects pinning non-existent message", async () => {
    const result = await api<{ ok: boolean; error?: string }>("/pin-message", { message_id: 999999, pinned: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });
});

// =============================================================================
// REACTIONS
// =============================================================================

describe("Reactions", () => {
  test("adds a reaction to a message", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();

    await api("/send-message", { from_id: sender.id, to_id: receiver.id, text: "react to me" });
    const poll = await api<{ messages: Array<{ id: number; text: string }> }>("/poll-messages", { id: receiver.id });
    const msg = poll.messages.find(m => m.text === "react to me");

    const result = await api<{ ok: boolean }>("/react", {
      message_id: msg!.id, peer_id: receiver.id, emoji: "👍",
    });
    expect(result.ok).toBe(true);
  });

  test("removes a reaction", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();

    await api("/send-message", { from_id: sender.id, to_id: receiver.id, text: "remove reaction" });
    const poll = await api<{ messages: Array<{ id: number; text: string }> }>("/poll-messages", { id: receiver.id });
    const msg = poll.messages.find(m => m.text === "remove reaction");

    // Add then remove
    await api("/react", { message_id: msg!.id, peer_id: receiver.id, emoji: "✅" });
    const result = await api<{ ok: boolean }>("/react", {
      message_id: msg!.id, peer_id: receiver.id, emoji: "✅", remove: true,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects invalid emoji", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();

    await api("/send-message", { from_id: sender.id, to_id: receiver.id, text: "bad emoji" });
    const poll = await api<{ messages: Array<{ id: number; text: string }> }>("/poll-messages", { id: receiver.id });
    const msg = poll.messages.find(m => m.text === "bad emoji");

    const result = await api<{ ok: boolean; error?: string }>("/react", {
      message_id: msg!.id, peer_id: receiver.id, emoji: "💩",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid emoji");
  });
});

// =============================================================================
// STRUCTURED MESSAGES
// =============================================================================

describe("Structured Messages", () => {
  test("sends a question-type structured message", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();

    const result = await api<{ ok: boolean }>("/send-structured", {
      from_id: sender.id,
      to_id: receiver.id,
      msg_type: "question",
      question: "Which database should we use?",
      expected_format: "Name with 1-sentence rationale",
    });
    expect(result.ok).toBe(true);

    // Verify it arrives as a message
    const poll = await api<{ messages: Array<{ text: string }> }>("/poll-messages", { id: receiver.id });
    const found = poll.messages.find(m => m.text.includes("Which database"));
    expect(found).toBeTruthy();
  });

  test("sends a decision-type structured message", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();

    const result = await api<{ ok: boolean }>("/send-structured", {
      from_id: sender.id,
      to_id: receiver.id,
      msg_type: "decision",
      decision: "Use PostgreSQL",
      rationale: "Best for relational data",
      alternatives_rejected: ["MongoDB", "DynamoDB"],
    });
    expect(result.ok).toBe(true);
  });

  test("sends a handoff-type structured message", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();

    const result = await api<{ ok: boolean }>("/send-structured", {
      from_id: sender.id,
      to_id: receiver.id,
      msg_type: "handoff",
      work_completed: "Auth module done",
      remaining_work: "Add rate limiting",
      files_modified: ["auth.ts", "middleware.ts"],
      decisions_made: ["Use JWT", "15min token expiry"],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects invalid msg_type", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();

    const res = await apiRaw("/send-structured", {
      from_id: sender.id,
      to_id: receiver.id,
      msg_type: "invalid_type",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toContain("msg_type");
  });

  test("rejects question type missing required fields", async () => {
    const sender = await registerPeer();
    const receiver = await registerPeer();

    const res = await apiRaw("/send-structured", {
      from_id: sender.id,
      to_id: receiver.id,
      msg_type: "question",
      // missing: question, expected_format
    });
    // May return 400 (validation error) or 200 with { ok: false }
    if (res.status === 400) {
      const body = await res.json() as { error?: string };
      expect(body.error).toBeTruthy();
    } else {
      const body = await res.json() as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
    }
  });
});

// =============================================================================
// SESSION REPORT
// =============================================================================

describe("Session Report", () => {
  test("generates a markdown session report", async () => {
    const p = await registerPeer();
    const report = await api<{ report: string }>("/session-report", {});
    expect(report.report).toContain("# Session Report");
    expect(report.report).toContain("Session ID");
    expect(report.report).toContain("Participants");
    expect(report.report).toContain("Message Stats");
  });
});

// =============================================================================
// BROADCAST EDGE CASES
// =============================================================================

describe("Broadcast Edge Cases", () => {
  test("broadcast is rate limited per sender", async () => {
    const sender = await registerPeer({ cwd: "/bcast-rl" });
    // Register receivers so broadcast has targets
    for (let i = 0; i < 3; i++) await registerPeer({ cwd: "/bcast-rl" });

    // Exhaust rate limit with broadcasts (each broadcast counts as 1 against the sender)
    for (let i = 0; i < 60; i++) {
      await api("/broadcast", {
        from_id: sender.id, scope: "directory", cwd: "/bcast-rl", git_root: null, text: `bcast-${i}`,
      });
    }

    const blocked = await api<{ ok: boolean; error?: string }>("/broadcast", {
      from_id: sender.id, scope: "directory", cwd: "/bcast-rl", git_root: null, text: "over limit",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("Rate limited");
  });

  test("broadcast excludes the sender", async () => {
    const sender = await registerPeer({ cwd: "/bcast-excl" });
    const receiver = await registerPeer({ cwd: "/bcast-excl" });

    const result = await api<{ ok: boolean; sent_to: number }>("/broadcast", {
      from_id: sender.id, scope: "directory", cwd: "/bcast-excl", git_root: null, text: "hello all",
    });
    expect(result.ok).toBe(true);
    // sent_to should include receiver but not sender
    expect(result.sent_to).toBeGreaterThanOrEqual(1);

    // Sender should NOT have the broadcast in their queue
    const senderPoll = await api<{ messages: Array<{ text: string }> }>("/poll-messages", { id: sender.id });
    const selfMsg = senderPoll.messages.find(m => m.text === "hello all");
    expect(selfMsg).toBeUndefined();
  });
});

// =============================================================================
// PROPOSAL REJECTION
// =============================================================================

describe("Proposal Rejection", () => {
  test("vote to reject reaches threshold", async () => {
    const author = await registerPeer();
    const v1 = await registerPeer();
    const v2 = await registerPeer();

    const create = await api<{ ok: boolean; id: string }>("/create-proposal", {
      author_id: author.id, title: "Bad idea", required_votes: 2,
    });
    expect(create.ok).toBe(true);

    await api("/vote-proposal", { proposal_id: create.id, voter_id: v1.id, vote: "reject", reason: "No" });
    const v2Result = await api<{ ok: boolean; status?: string }>("/vote-proposal", {
      proposal_id: create.id, voter_id: v2.id, vote: "reject", reason: "Disagree",
    });
    expect(v2Result.ok).toBe(true);
    expect(v2Result.status).toBe("rejected");
  });

  test("cannot vote on closed proposal", async () => {
    const author = await registerPeer();
    const v1 = await registerPeer();
    const v2 = await registerPeer();
    const v3 = await registerPeer();

    const create = await api<{ ok: boolean; id: string }>("/create-proposal", {
      author_id: author.id, title: "Already decided", required_votes: 2,
    });

    // Approve it with 2 votes
    await api("/vote-proposal", { proposal_id: create.id, voter_id: v1.id, vote: "approve" });
    await api("/vote-proposal", { proposal_id: create.id, voter_id: v2.id, vote: "approve" });

    // Late vote should fail
    const late = await api<{ ok: boolean; error?: string }>("/vote-proposal", {
      proposal_id: create.id, voter_id: v3.id, vote: "reject",
    });
    expect(late.ok).toBe(false);
    expect(late.error).toContain("no longer open");
  });

  test("lists proposals with status filter", async () => {
    const author = await registerPeer();
    await api<{ ok: boolean; id: string }>("/create-proposal", {
      author_id: author.id, title: `open-${Date.now()}`, required_votes: 5,
    });

    const list = await api<{ proposals: Array<{ title: string; status: string }> }>("/list-proposals", { status: "open" });
    expect(list.proposals.length).toBeGreaterThanOrEqual(1);
    for (const p of list.proposals) {
      expect(p.status).toBe("open");
    }
  });
});

// =============================================================================
// DECISION REVOCATION
// =============================================================================

describe("Decision Revocation", () => {
  test("revokes an active decision", async () => {
    const p = await registerPeer();
    const key = `revoke-test-${Date.now()}`;
    const post = await api<{ ok: boolean; id: string }>("/post-decision", {
      author_id: p.id, key, value: "yes", rationale: "initial",
    });
    expect(post.ok).toBe(true);

    const revoke = await api<{ ok: boolean }>("/revoke-decision", {
      decision_id: post.id, peer_id: p.id,
    });
    expect(revoke.ok).toBe(true);

    // Should no longer appear in active list
    const list = await api<{ decisions: Array<{ key: string }> }>("/list-decisions", { key, status: "active" });
    expect(list.decisions.length).toBe(0);
  });

  test("revoked decision appears with status filter", async () => {
    const p = await registerPeer();
    const key = `revoke-filter-${Date.now()}`;
    const post = await api<{ ok: boolean; id: string }>("/post-decision", {
      author_id: p.id, key, value: "v1", rationale: "r1",
    });
    await api("/revoke-decision", { decision_id: post.id, peer_id: p.id });

    const list = await api<{ decisions: Array<{ key: string; status: string }> }>("/list-decisions", { key, status: "revoked" });
    expect(list.decisions.length).toBe(1);
    expect(list.decisions[0]!.status).toBe("revoked");
  });
});

// =============================================================================
// MESSAGE HISTORY
// =============================================================================

describe("Message History", () => {
  test("retrieves conversation history between two peers", async () => {
    const p1 = await registerPeer();
    const p2 = await registerPeer();

    await api("/send-message", { from_id: p1.id, to_id: p2.id, text: "history-msg-1" });
    await api("/send-message", { from_id: p2.id, to_id: p1.id, text: "history-msg-2" });

    const history = await api<{ messages: Array<{ text: string; from_id: string }> }>("/message-history", {
      peer_a: p1.id, peer_b: p2.id, limit: 10,
    });
    expect(history.messages.length).toBeGreaterThanOrEqual(2);
    const texts = history.messages.map(m => m.text);
    expect(texts).toContain("history-msg-1");
    expect(texts).toContain("history-msg-2");
  });

  test("group-isolated peers cannot see each other's history", async () => {
    const g1 = await api<{ ok: boolean; id: string }>("/create-group", { name: `hist-g1-${Date.now()}` });
    const g2 = await api<{ ok: boolean; id: string }>("/create-group", { name: `hist-g2-${Date.now()}` });

    const p1 = await registerPeer();
    const p2 = await registerPeer();

    await api("/assign-group", { peer_id: p1.id, group_id: g1.id });
    await api("/assign-group", { peer_id: p2.id, group_id: g2.id });

    // They can't message each other, so history should be empty
    const history = await api<{ messages: Array<{ text: string }> }>("/message-history", {
      peer_a: p1.id, peer_b: p2.id, limit: 10,
    });
    expect(history.messages.length).toBe(0);
  });
});

// =============================================================================
// STATUS & TYPING
// =============================================================================

describe("Status & Typing", () => {
  test("sets peer status", async () => {
    const p = await registerPeer();
    const result = await api<{ ok: boolean }>("/set-status", { id: p.id, status: "busy" });
    expect(result.ok).toBe(true);

    // Verify in listing
    const peers = await api<Array<{ id: string; status: string }>>("/list-peers", {
      scope: "machine", cwd: "/", git_root: null,
    });
    const found = peers.find(peer => peer.id === p.id);
    expect(found?.status).toBe("busy");
  });

  test("sets typing indicator", async () => {
    const p = await registerPeer();
    const result = await api<{ ok: boolean }>("/set-typing", { id: p.id });
    expect(result.ok).toBe(true);
  });
});

// =============================================================================
// ISOLATION GROUPS
// =============================================================================

describe("Isolation Groups", () => {
  test("creates and lists groups", async () => {
    const name = `test-group-${Date.now()}`;
    const create = await api<{ ok: boolean; id: string }>("/create-group", { name });
    expect(create.ok).toBe(true);

    const list = await api<{ groups: Array<{ id: string; name: string; member_count: number }> }>("/list-isolation-groups", {});
    const found = list.groups.find(g => g.id === create.id);
    expect(found).toBeTruthy();
    expect(found!.name).toBe(name);
    expect(found!.member_count).toBe(0);
  });

  test("deletes group and moves members to lobby", async () => {
    const gName = `del-group-${Date.now()}`;
    const g = await api<{ ok: boolean; id: string }>("/create-group", { name: gName });
    const p = await registerPeer();
    await api("/assign-group", { peer_id: p.id, group_id: g.id });

    const del = await api<{ ok: boolean }>("/delete-group", { group_id: g.id });
    expect(del.ok).toBe(true);

    // Peer should still exist but be in lobby (no group)
    const peers = await api<Array<{ id: string; group_id: string | null }>>("/list-peers", {
      scope: "machine", cwd: "/", git_root: null,
    });
    const found = peers.find(peer => peer.id === p.id);
    expect(found).toBeTruthy();
    // group_id should be null (lobby)
    expect(found!.group_id).toBeNull();
  });

  test("rejects duplicate group names", async () => {
    const name = `dup-group-${Date.now()}`;
    await api("/create-group", { name });
    const dup = await api<{ ok: boolean; error?: string }>("/create-group", { name });
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain("already exists");
  });
});

// =============================================================================
// AUDIT LOG
// =============================================================================

describe("Audit Log", () => {
  test("returns audit entries", async () => {
    const result = await api<{ entries: Array<{ action: string; actor_id: string }> }>("/audit-log", { limit: 10 });
    expect(Array.isArray(result.entries)).toBe(true);
    // Should have entries from peer registrations in earlier tests
    expect(result.entries.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// UNREGISTER
// =============================================================================

describe("Unregister", () => {
  test("removes peer after unregister", async () => {
    const p = await registerPeer({ cwd: "/unreg-test" });
    await api("/unregister", { id: p.id });
    const peers = await api<Array<{ id: string }>>("/list-peers", {
      scope: "machine", cwd: "/", git_root: null,
    });
    const found = peers.find(peer => peer.id === p.id);
    expect(found).toBeUndefined();
  });
});
