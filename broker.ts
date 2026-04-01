#!/usr/bin/env bun
/**
 * claude-peers broker daemon — Entry point
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 *
 * Module structure:
 *   broker/db.ts       — Database, schema, prepared statements, state, helpers
 *   broker/validate.ts — Input validation (23 validators)
 *   broker/handlers.ts — All request handler functions (44 handlers)
 *   broker.ts          — This file: HTTP server, routing, WebSocket, dashboard
 */

// --- Database, state, and helpers ---
import {
  db,
  log,
  PORT,
  DB_PATH,
  setOnStateChange,
  startPeriodicCleanup,
} from "./broker/db.ts";

// --- Validators ---
import {
  ValidationError,
  validateBody,
  validateString,
  validateNumber,
  validateRegisterRequest,
  validateHeartbeatRequest,
  validateSetSummaryRequest,
  validateListPeersRequest,
  validateSendMessageRequest,
  validatePollMessagesRequest,
  validateUnregisterRequest,
  validateBroadcastRequest,
  validateAckMessageRequest,
  validateCheckAcksRequest,
  validateSetNameRequest,
  validateSetStatusRequest,
  validateSetTypingRequest,
  validateMessageHistoryRequest,
  validateSendStructuredRequest,
  validatePostDecisionRequest,
  validateListDecisionsRequest,
  validateRevokeDecisionRequest,
  validateRequestVerificationRequest,
  validateRespondVerificationRequest,
  validateListVerificationsRequest,
  validateCreateProposalRequest,
  validateVoteProposalRequest,
  validateListProposalsRequest,
} from "./broker/validate.ts";

// --- Handlers ---
import {
  handleRegister,
  handleSetName,
  handleHeartbeat,
  handleSetSummary,
  handleListPeers,
  handleSendMessage,
  handlePollMessages,
  handleUnregister,
  handleBroadcast,
  handleAckMessage,
  handleCheckAcks,
  handleCreateIsolationGroup,
  handleAssignGroup,
  handleDeleteIsolationGroup,
  handleListIsolationGroups,
  handleSetStatus,
  handleSetTyping,
  handlePinMessage,
  handleCreateTask,
  handleCompleteTask,
  handleListTasks,
  handleSetActiveFiles,
  handleReaction,
  handleRequestApproval,
  handleRespondApproval,
  handleListApprovals,
  handleSessionReport,
  handleGetAuditLog,
  handleSendStructured,
  handlePostDecision,
  handleListDecisions,
  handleRevokeDecision,
  handleRequestVerification,
  handleRespondVerification,
  handleListVerifications,
  handleCreateProposal,
  handleVoteProposal,
  handleListProposals,
  handleMessageHistory,
  getDashboardState,
} from "./broker/handlers.ts";

// --- Dashboard ---

const DASHBOARD_PATH = new URL("./dashboard.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DASHBOARD_JS_PATH = new URL("./dashboard.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// Pre-compute ETags from file mtimes at startup (invalidates on broker restart / file change)
const dashboardHtmlEtag = `"${Bun.file(DASHBOARD_PATH).lastModified}"`;
const dashboardJsEtag = `"${Bun.file(DASHBOARD_JS_PATH).lastModified}"`;

// --- WebSocket clients for dashboard ---

const dashboardClients = new Set<any>();

// Debounced dashboard broadcast — coalesces rapid updates into a single push
let dashboardBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
const DASHBOARD_DEBOUNCE_MS = 200;

function broadcastDashboard() {
  if (dashboardClients.size === 0) return;
  if (dashboardBroadcastTimer) return; // already scheduled
  dashboardBroadcastTimer = setTimeout(() => {
    dashboardBroadcastTimer = null;
    if (dashboardClients.size === 0) return;
    const state = JSON.stringify(getDashboardState());
    for (const ws of dashboardClients) {
      try { ws.send(state); } catch { dashboardClients.delete(ws); }
    }
  }, DASHBOARD_DEBOUNCE_MS);
}

// Wire up the state-change callback so db.ts periodic cleanup can trigger dashboard updates
setOnStateChange(broadcastDashboard);

// Start the periodic cleanup (stale peers, rate limits, expired messages, typing indicators)
startPeriodicCleanup();

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
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
        const peerCount = (db.query("SELECT COUNT(*) as cnt FROM peers").get() as { cnt: number }).cnt;
        return Response.json({ status: "ok", peers: peerCount });
      }
      if (path === "/api/dashboard-state") {
        return Response.json(getDashboardState());
      }
      if (path === "/dashboard.js") {
        if (req.headers.get("if-none-match") === dashboardJsEtag) {
          return new Response(null, { status: 304 });
        }
        return new Response(Bun.file(DASHBOARD_JS_PATH), {
          headers: { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=3600", "ETag": dashboardJsEtag },
        });
      }
      // Serve dashboard HTML for root path
      if (req.headers.get("if-none-match") === dashboardHtmlEtag) {
        return new Response(null, { status: 304 });
      }
      return new Response(Bun.file(DASHBOARD_PATH), {
        headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600", "ETag": dashboardHtmlEtag },
      });
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
        case "/unregister": {
          const unreg = validateUnregisterRequest(body);
          const rawBody = body as Record<string, unknown>;
          handleUnregister({ ...unreg, broadcast_departure: rawBody.broadcast_departure === true });
          return Response.json({ ok: true });
        }
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
        case "/react": {
          const b = validateBody(body);
          return Response.json(handleReaction({
            message_id: validateNumber(b.message_id, "message_id"),
            peer_id: validateString(b.peer_id, "peer_id"),
            emoji: validateString(b.emoji, "emoji"),
            remove: b.remove === true,
          }));
        }
        case "/request-approval": {
          const b = validateBody(body);
          return Response.json(handleRequestApproval({
            requester_id: validateString(b.requester_id, "requester_id"),
            approver_id: validateString(b.approver_id, "approver_id"),
            action_description: validateString(b.action_description, "action_description"),
          }));
        }
        case "/respond-approval": {
          const b = validateBody(body);
          return Response.json(handleRespondApproval({
            approval_id: validateString(b.approval_id, "approval_id"),
            peer_id: validateString(b.peer_id, "peer_id"),
            approved: b.approved === true,
            reason: typeof b.reason === "string" ? b.reason : undefined,
          }));
        }
        case "/list-approvals": {
          const b = validateBody(body);
          return Response.json(handleListApprovals({
            peer_id: typeof b.peer_id === "string" ? b.peer_id : undefined,
            status: typeof b.status === "string" ? b.status : undefined,
          }));
        }
        case "/session-report":
          return Response.json(handleSessionReport());
        case "/audit-log": {
          const b = validateBody(body);
          return Response.json(handleGetAuditLog({ limit: typeof b.limit === "number" ? b.limit : undefined }));
        }

        // --- Structured Messages ---
        case "/send-structured":
          return Response.json(handleSendStructured(validateSendStructuredRequest(body)));

        // --- Decisions Board ---
        case "/post-decision":
          return Response.json(handlePostDecision(validatePostDecisionRequest(body)));
        case "/list-decisions":
          return Response.json(handleListDecisions(validateListDecisionsRequest(body)));
        case "/revoke-decision":
          return Response.json(handleRevokeDecision(validateRevokeDecisionRequest(body)));

        // --- Verification Protocol ---
        case "/request-verification":
          return Response.json(handleRequestVerification(validateRequestVerificationRequest(body)));
        case "/respond-verification":
          return Response.json(handleRespondVerification(validateRespondVerificationRequest(body)));
        case "/list-verifications":
          return Response.json(handleListVerifications(validateListVerificationsRequest(body)));

        // --- Consensus Protocol ---
        case "/create-proposal":
          return Response.json(handleCreateProposal(validateCreateProposalRequest(body)));
        case "/vote-proposal":
          return Response.json(handleVoteProposal(validateVoteProposalRequest(body)));
        case "/list-proposals":
          return Response.json(handleListProposals(validateListProposalsRequest(body)));

        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const isValidation = e instanceof ValidationError;
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: isValidation ? 400 : 500 });
    } finally {
      // Push state to dashboard clients after state-changing POSTs (skip heartbeats & read-only queries)
      const skipBroadcast = path === "/heartbeat" || path === "/poll-messages" || path === "/check-acks"
        || path === "/list-peers" || path === "/list-tasks" || path === "/list-approvals"
        || path === "/list-decisions" || path === "/list-verifications" || path === "/list-proposals"
        || path === "/list-isolation-groups" || path === "/message-history" || path === "/audit-log"
        || path === "/session-report";
      if (req.method === "POST" && !skipBroadcast) broadcastDashboard();
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

log.info(`listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
