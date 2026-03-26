#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-peers
 *
 * With .mcp.json:
 *   { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  Message,
  BroadcastResponse,
} from "./shared/types.ts";
import { createLogger } from "./shared/log.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MAX_CONSECUTIVE_FAILURES = 5;
const RECONNECT_DELAY_MS = 2000;

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log.info("Broker already running");
    return;
  }

  log.info("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    // Detach so the broker survives if this MCP server exits
    // On macOS/Linux, the broker will keep running
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log.info("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Logging ---

const log = createLogger("server");

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      const branch = text.trim();
      return branch === "HEAD" ? null : branch; // detached HEAD
    }
  } catch { /* not a git repo */ }
  return null;
}

function getTty(): string | null {
  if (process.platform === "win32") return null;
  try {
    // Try to get the parent's tty from the process tree
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- State ---

let myId: PeerId | null = null;
let myName: string = "";
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let consecutivePollFailures = 0;
let reconnectPromise: Promise<void> | null = null;
let isPolling = false;

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances on this machine can see you and send you messages. You have been automatically assigned a name (e.g. "claude-1") that other peers see.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Pause what you are doing, reply using send_message, then resume your work.

CRITICAL RULES FOR REPLYING:
1. Put your ENTIRE response into the send_message call. The recipient can ONLY see what you put in send_message — they cannot see your terminal output. Never split between a brief message and terminal text.
2. Use Markdown formatting in your messages: **bold**, *italic*, inline code, code blocks, headings (##), lists (- item). This makes your replies readable in the dashboard.
3. For multi-step tasks, send progress updates as separate messages:
   - First: "Starting [task]..."
   - During: "Progress: [status]"
   - Done: "Completed. Here's the result: [details]"
4. Include all relevant context: what you did, what changed, any errors, next steps.
5. If you call tools (set_summary, etc.), also mention what you did in your send_message reply so the recipient sees the full picture.

Read the from_name (or from_id), from_summary, from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id or from_name.

Available tools:
- list_peers: Discover other Claude Code instances (scope: machine/directory/repo). Shows name, id, cwd, summary.
- send_message: Send a message to another instance by peer ID or name
- broadcast_message: Send a message to all peers matching a scope (machine/directory/repo)
- set_name: Change your display name (default: claude-N)
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages
- ack_message: Acknowledge receipt of a message (use message_id from channel notification)
- check_acks: See if your sent messages have been acknowledged
- message_history: Retrieve past conversation with a specific peer
- set_status: Set your presence (online/away/busy)

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by name or ID. The message will be pushed into their session immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer name (e.g. 'claude-1') or ID of the target instance",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_name",
    description:
      "Change your display name. Default is claude-N (auto-assigned). Other peers see this name when listing peers or receiving messages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "Your new display name",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "broadcast_message",
    description:
      "Send a message to all Claude Code instances matching a scope. 'machine' sends to everyone, 'directory' to peers in the same working directory, 'repo' to peers in the same git repository.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description: "Who to broadcast to",
        },
        message: {
          type: "string" as const,
          description: "The message to broadcast",
        },
      },
      required: ["scope", "message"],
    },
  },
  {
    name: "ack_message",
    description:
      "Acknowledge receipt of a message. Use the message_id from the channel notification meta.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "number" as const,
          description: "The ID of the message to acknowledge",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "check_acks",
    description:
      "Check if messages you sent have been acknowledged by their recipients.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number" as const,
          description: "Maximum number of recent messages to check (default: 20)",
        },
      },
    },
  },
  {
    name: "message_history",
    description: "Retrieve past messages between you and another peer in the current session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: { type: "string" as const, description: "The peer name or ID to get history with" },
        limit: { type: "number" as const, description: "Max messages to return (default: 50)" },
      },
      required: ["peer_id"],
    },
  },
  {
    name: "set_status",
    description: "Set your presence status. Visible to other peers and the dashboard.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string" as const,
          enum: ["online", "away", "busy"],
          description: "Your presence status",
        },
      },
      required: ["status"],
    },
  },
  {
    name: "create_task",
    description: "Create a task and optionally assign it to another peer. The assignee will receive a notification message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: "Task title (max 200 chars)" },
        description: { type: "string" as const, description: "Optional task description" },
        assignee: { type: "string" as const, description: "Peer name or ID to assign the task to (optional)" },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as completed, optionally with a result message. The task creator will be notified.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const, description: "The ID of the task to complete" },
        result: { type: "string" as const, description: "Optional result or summary of what was done" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "list_tasks",
    description: "List tasks in the current session. Can filter by status (pending/completed).",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string" as const, enum: ["pending", "completed"], description: "Filter by task status" },
      },
    },
  },
  {
    name: "set_active_files",
    description: "Report which files you are currently editing. Other peers editing the same files will be flagged as conflicts. Call this when you start or stop editing files.",
    inputSchema: {
      type: "object" as const,
      properties: {
        files: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "List of file paths you are currently editing. Pass empty array to clear.",
        },
      },
      required: ["files"],
    },
  },
  {
    name: "pin_message",
    description: "Pin or unpin a message. Pinned messages stay visible at the top of the dashboard chat.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: { type: "number" as const, description: "The message ID to pin/unpin" },
        pinned: { type: "boolean" as const, description: "true to pin, false to unpin (default: true)" },
      },
      required: ["message_id"],
    },
  },
  {
    name: "react",
    description: "Add or remove an emoji reaction on a message. Lightweight feedback without a full reply.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: { type: "number" as const, description: "The message ID to react to" },
        emoji: { type: "string" as const, description: "Emoji to react with: 👍 👀 ✅ ⚠️ ❌ 🎉 ❤️ 🤔" },
        remove: { type: "boolean" as const, description: "true to remove the reaction (default: false)" },
      },
      required: ["message_id", "emoji"],
    },
  },
  {
    name: "request_approval",
    description: "Request approval from another peer before taking a potentially dangerous action. The approver receives a notification and can accept or reject.",
    inputSchema: {
      type: "object" as const,
      properties: {
        approver: { type: "string" as const, description: "Peer name or ID to request approval from" },
        action: { type: "string" as const, description: "Description of the action you want to take" },
      },
      required: ["approver", "action"],
    },
  },
  {
    name: "respond_approval",
    description: "Accept or reject an approval request from another peer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        approval_id: { type: "string" as const, description: "The approval request ID" },
        approved: { type: "boolean" as const, description: "true to approve, false to reject" },
        reason: { type: "string" as const, description: "Optional reason for the decision" },
      },
      required: ["approval_id", "approved"],
    },
  },
  {
    name: "session_report",
    description: "Generate a structured markdown report of the current session: participants, tasks, messages, activity log.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map((p) => {
          const parts = [
            `Name: ${p.name || p.id}`,
            `ID: ${p.id}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Group: ${p.group_id ? p.group_id : "lobby"}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        // Resolve name to ID if needed
        let resolvedId = to_id;
        const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: myCwd, git_root: myGitRoot });
        const byName = peers.find((p) => p.name === to_id);
        if (byName) resolvedId = byName.id;

        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id: resolvedId,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        const targetLabel = byName ? byName.name : resolvedId;
        return {
          content: [{ type: "text" as const, text: `Message sent to ${targetLabel}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_name": {
      const { name } = args as { name: string };
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/set-name", { id: myId, name });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        }
        myName = name;
        process.stderr.write(`\x1b]0;${myName}\x07`);
        return { content: [{ type: "text" as const, text: `Name changed to "${name}"` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = result.messages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "broadcast_message": {
      const { scope, message } = args as { scope: "machine" | "directory" | "repo"; message: string };
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        const result = await brokerFetch<BroadcastResponse>("/broadcast", {
          from_id: myId, scope, cwd: myCwd, git_root: myGitRoot, text: message,
        });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Failed to broadcast: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Broadcast sent to ${result.sent_to} peer(s) (scope: ${scope})` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error broadcasting: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "ack_message": {
      const { message_id } = args as { message_id: number };
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/ack-message", { id: myId, message_id });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Failed to ack: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Message ${message_id} acknowledged` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "check_acks": {
      const limit = (args as { limit?: number }).limit ?? 20;
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        const result = await brokerFetch<{ messages: Array<{ id: number; to_id: string; text: string; sent_at: string; acknowledged: boolean }> }>("/check-acks", { from_id: myId, limit });
        if (result.messages.length === 0) {
          return { content: [{ type: "text" as const, text: "No sent messages found." }] };
        }
        const lines = result.messages.map((m) => {
          const status = m.acknowledged ? "[ACK]" : "[pending]";
          return `${status} To ${m.to_id} (${m.sent_at}): ${m.text.slice(0, 60)}`;
        });
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "message_history": {
      const { peer_id, limit } = args as { peer_id: string; limit?: number };
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        // Resolve name to ID
        let resolvedId = peer_id;
        const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: myCwd, git_root: myGitRoot });
        const byName = peers.find((p) => p.name === peer_id);
        if (byName) resolvedId = byName.id;

        const result = await brokerFetch<{ messages: Array<{ from_id: string; to_id: string; text: string; sent_at: string }> }>(
          "/message-history", { peer_a: myId, peer_b: resolvedId, limit: limit ?? 50 }
        );
        if (result.messages.length === 0) {
          return { content: [{ type: "text" as const, text: "No message history with this peer." }] };
        }
        const nm: Record<string, string> = {};
        peers.forEach((p) => { nm[p.id] = p.name || p.id; });
        nm[myId] = myName || myId;
        const lines = result.messages.map((m) =>
          `[${m.sent_at}] ${nm[m.from_id] || m.from_id} → ${nm[m.to_id] || m.to_id}: ${m.text}`
        );
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "set_status": {
      const { status } = args as { status: string };
      if (!myId) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        await brokerFetch("/set-status", { id: myId, status });
        return { content: [{ type: "text" as const, text: `Status set to "${status}"` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "create_task": {
      const { title, description, assignee } = args as { title: string; description?: string; assignee?: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      try {
        let assigneeId = assignee;
        if (assignee) {
          const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: myCwd, git_root: myGitRoot });
          const byName = peers.find((p) => p.name === assignee);
          if (byName) assigneeId = byName.id;
        }
        const result = await brokerFetch<{ ok: boolean; id?: string; error?: string }>("/create-task", {
          title, description: description || "", creator_id: myId, assignee_id: assigneeId,
        });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Task created (${result.id})${assigneeId ? ` and assigned to ${assignee}` : ""}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "complete_task": {
      const { task_id, result } = args as { task_id: string; result?: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      try {
        const res = await brokerFetch<{ ok: boolean; error?: string }>("/complete-task", { task_id, peer_id: myId, result });
        if (!res.ok) return { content: [{ type: "text" as const, text: `Failed: ${res.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Task ${task_id} marked as completed` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "list_tasks": {
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      try {
        const status = (args as { status?: string }).status;
        const result = await brokerFetch<{ tasks: any[] }>("/list-tasks", { peer_id: myId, status });
        if (result.tasks.length === 0) return { content: [{ type: "text" as const, text: "No tasks found." }] };
        const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: myCwd, git_root: myGitRoot });
        const nm: Record<string, string> = {};
        peers.forEach((p) => { nm[p.id] = p.name || p.id; });
        nm[myId] = myName || myId;
        const lines = result.tasks.map((t: any) => {
          const assignee = t.assignee_id ? (nm[t.assignee_id] || t.assignee_id) : "unassigned";
          const st = t.status === "completed" ? "[done]" : "[pending]";
          return `${st} ${t.id}: ${t.title} (assignee: ${assignee})`;
        });
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "set_active_files": {
      const { files } = args as { files: string[] };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      try {
        const result = await brokerFetch<{ ok: boolean; conflicts?: Array<{ file: string; peer_name: string }> }>("/set-active-files", { id: myId, files });
        if (result.conflicts && result.conflicts.length > 0) {
          const warnings = result.conflicts.map((c) => `  - ${c.file} (also edited by ${c.peer_name})`);
          return { content: [{ type: "text" as const, text: `Active files updated. CONFLICTS detected:\n${warnings.join("\n")}` }] };
        }
        return { content: [{ type: "text" as const, text: `Active files updated (${files.length} file${files.length !== 1 ? "s" : ""})` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "pin_message": {
      const { message_id, pinned } = args as { message_id: number; pinned?: boolean };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/pin-message", { message_id, pinned: pinned !== false });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Message ${message_id} ${pinned !== false ? "pinned" : "unpinned"}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "react": {
      const { message_id, emoji, remove } = args as { message_id: number; emoji: string; remove?: boolean };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/react", { message_id, peer_id: myId, emoji, remove: remove === true });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `${remove ? "Removed" : "Added"} ${emoji} reaction` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "request_approval": {
      const { approver, action } = args as { approver: string; action: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      try {
        let approverId = approver;
        const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "machine", cwd: myCwd, git_root: myGitRoot });
        const byName = peers.find((p) => p.name === approver);
        if (byName) approverId = byName.id;
        const result = await brokerFetch<{ ok: boolean; id?: string; error?: string }>("/request-approval", {
          requester_id: myId, approver_id: approverId, action_description: action,
        });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Approval requested (ID: ${result.id}). Waiting for ${approver} to respond.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "respond_approval": {
      const { approval_id, approved, reason } = args as { approval_id: string; approved: boolean; reason?: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/respond-approval", {
          approval_id, peer_id: myId, approved, reason,
        });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Approval ${approved ? "granted" : "rejected"}${reason ? `: ${reason}` : ""}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "session_report": {
      try {
        const result = await brokerFetch<{ report: string }>("/session-report", {});
        return { content: [{ type: "text" as const, text: result.report }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Reconnection ---

async function reconnectToBroker() {
  log.warn("Attempting to reconnect to broker...");
  try {
    await ensureBroker();
    const tty = getTty();
    const branch = await getGitBranch(myCwd);
    const reg = await brokerFetch<RegisterResponse>("/register", {
      pid: process.pid,
      cwd: myCwd,
      git_root: myGitRoot,
      git_branch: branch,
      tty,
      summary: "",
    });
    myId = reg.id;
    myName = reg.name;
    consecutivePollFailures = 0;
    log.info(`Reconnected as ${myName} (${myId})`);
    process.stderr.write(`\x1b]0;${myName}\x07`);
  } catch (e) {
    log.error(`Reconnection failed: ${e instanceof Error ? e.message : String(e)}`);
    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
  }
}

function triggerReconnect() {
  if (reconnectPromise) return;
  reconnectPromise = reconnectToBroker()
    .catch(() => { }) // swallow — already logged inside reconnectToBroker
    .finally(() => { reconnectPromise = null; });
}

// --- Polling loop for inbound messages ---

async function pollAndPushMessages() {
  if (!myId || reconnectPromise || isPolling) return;
  isPolling = true;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    consecutivePollFailures = 0;

    for (const msg of result.messages) {
      // Look up the sender's info for context
      let fromName = msg.from_id;
      let fromSummary = "";
      let fromCwd = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope: "machine",
          cwd: myCwd,
          git_root: myGitRoot,
        });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) {
          fromName = sender.name || sender.id;
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
        }
      } catch {
        // Non-critical, proceed without sender info
      }

      // Push as channel notification — meta values must all be strings
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: msg.from_id,
            from_name: fromName,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            sent_at: msg.sent_at,
          },
        },
      });

      log.info(`Pushed msg ${msg.id} from ${fromName}`);
    }
  } catch (e) {
    consecutivePollFailures++;
    log.warn(`Poll error (${consecutivePollFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e instanceof Error ? e.message : String(e)}`);
    if (consecutivePollFailures >= MAX_CONSECUTIVE_FAILURES) {
      triggerReconnect();
    }
  } finally {
    isPolling = false;
  }
}

// --- Startup ---

async function main() {
  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const myBranch = await getGitBranch(myCwd);
  const tty = getTty();

  log.info(`CWD: ${myCwd}`);
  log.info(`Git root: ${myGitRoot ?? "(none)"}`);
  log.info(`Git branch: ${myBranch ?? "(none)"}`);
  log.info(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Register with broker (summary is set later by Claude via set_summary tool)
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    git_branch: myBranch,
    tty,
    summary: "",
  });
  myId = reg.id;
  myName = reg.name;
  log.info(`Registered as ${myName} (${myId})`);

  // Set terminal tab title to peer name
  process.stderr.write(`\x1b]0;${myName}\x07`);

  // 4. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log.info("MCP connected");

  // 6. Start polling for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 7. Start heartbeat (also detects broker death)
  const heartbeatTimer = setInterval(async () => {
    if (!myId || reconnectPromise) return;
    try {
      await brokerFetch("/heartbeat", { id: myId });
      consecutivePollFailures = 0;
    } catch {
      consecutivePollFailures++;
      if (consecutivePollFailures >= MAX_CONSECUTIVE_FAILURES) triggerReconnect();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId, broadcast_departure: true });
        log.info("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
