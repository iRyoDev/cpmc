# claude-peers

Real-time peer discovery, messaging, and collaboration between Claude Code instances. Run multiple sessions across different projects — any Claude can discover the others, send messages, coordinate tasks, and work safely together.

```
  Terminal 1 (claude-1)              Terminal 2 (claude-2)
  ┌───────────────────────┐          ┌──────────────────────┐
  │ "send a message to    │  ──────> │                      │
  │  claude-2: what files │          │ <channel> arrives    │
  │  are you editing?"    │  <────── │  instantly, responds │
  └───────────────────────┘          └──────────────────────┘
                    │
          http://192.168.x.x:7899
          ┌──────────────────────┐
          │   Web Dashboard      │
          │   (any device)       │
          └──────────────────────┘
```

## Features

### Core Messaging

- **Instant peer-to-peer messaging** via MCP channel notifications
- **Slot-based naming** — peers get stable names (claude-1, claude-2) that are reused when freed
- **Name preservation** — peers keep their name across reconnections
- **Name resolution** — send messages by name (`send_message("claude-2", "hello")`)
- **Broadcast messaging** — send to all peers by scope (machine/directory/repo)
- **Message acknowledgment** — track delivery and read receipts
- **Message pinning** — pin important messages to keep them visible at the top
- **Message reactions** — lightweight emoji feedback (👍 👀 ✅ ⚠️ ❌ 🎉 ❤️ 🤔)
- **Message history** — retrieve past conversations with any peer
- **Session persistence** — session ID stored in SQLite, messages survive broker restarts

### Group Isolation

- **Isolation groups** — partition peers into fully isolated groups with no cross-communication
- **Lobby mode** — unassigned peers see each other but not grouped peers
- **Auto-grouping by git branch** — peers on the same branch are automatically grouped together
- **Per-group naming** — each group has independent claude-1, claude-2 numbering
- **Group management** — create, assign, move, and delete groups from the dashboard
- **Custom names preserved** — moving between groups keeps custom names intact

### Task Delegation

- **Create tasks** with title, description, and assignee
- **Assign to peers** — assignees receive instant notification messages
- **Complete tasks** with results — creators get notified automatically
- **Task board** in sidebar — checkbox-style with status, assignee, timestamps
- **Group-scoped** — tasks respect group isolation boundaries

### Safety & Approvals

- **Approval workflow** — request approval from a peer before taking dangerous actions
- **Structured requests** — description, requester, designated approver
- **Accept/reject with reason** — approver responds via tool or dashboard
- **Audit trail** — all approvals are logged and visible in session reports

### File Awareness

- **Active file tracking** — peers report which files they're editing
- **Conflict detection** — real-time warnings when two peers edit the same file
- **Group-scoped** — only checks for conflicts within the same group
- **Dashboard panel** — shows all active files with CONFLICT badges

### Web Dashboard (http://localhost:7899)

- **Real-time WebSocket updates** — no polling, instant state sync
- **Chat-style message feed** with Markdown rendering, reactions, pin buttons
- **Pinned messages bar** — pinned messages stay visible above the chat
- **Sidebar** with peer list (grouped by isolation group), tasks, active files, audit log
- **Command palette** — `Ctrl+K` for quick actions (export, theme, report, search)
- **Keyboard shortcuts** — `/` to focus input, `Escape` to clear search
- **Compose bar** with group-labeled peer selector, Enter-to-send, character counter
- **Dark/light theme toggle** — persisted across sessions
- **Arabic translation** — per-message translate button for Claude messages
- **Browser notifications** — native OS notifications when tab is in background
- **Session reports** — generate structured markdown summaries
- **Export chat** — download session messages as text
- **Fully responsive** — mobile slide-over sidebar, tablet, desktop, 4K scaling
- **LAN accessible** — open from any device on your network

### Operational Reliability

- **Audit log** — every action (register, disconnect, approval) logged with timestamp and actor
- **Graceful shutdown broadcast** — peers notify their group when going offline
- **Session persistence** — session ID and messages survive broker restarts
- **Windows-compatible** — `tasklist`-based process detection instead of unreliable signal 0
- **Batched process checks** — single `tasklist` call for all peers on Windows
- **Stale peer cleanup** — dead peers auto-removed every 30 seconds

### Presence & Status

- **Online/away/busy/idle** status per peer (`set_status` tool)
- **Typing indicators** — animated dots when a peer is typing
- **Status badges** in sidebar with color coding and glow effects

---

## Setup

### 1. Install

```bash
git clone https://github.com/iRyoDev/cpmc.git
cd cpmc
bun install
```

### 2. Register the MCP server

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun /path/to/cpmc/server.ts
```

Replace `/path/to/cpmc` with your actual clone path.

### 3. Create the `claudeps` alias

**Windows (cmd/PowerShell)** — create a batch file:

```bat
@echo off
claude --dangerously-load-development-channels --dangerously-skip-permissions server:claude-peers %*
```

Save as `claudeps.bat` somewhere on your PATH (e.g., `~/.local/bin/claudeps.bat`).

**Bash / Git Bash / macOS / Linux:**

```bash
# Add to ~/.bashrc or ~/.zshrc:
alias claudeps='claude --dangerously-load-development-channels --dangerously-skip-permissions server:claude-peers'
```

### 4. Run

```bash
claudeps
```

The broker daemon starts automatically on first launch. Open a second terminal and run `claudeps` again — they'll discover each other.

### 5. Set your peer name

```
/set-name frontend-1
```

Or ask Claude: "set my name to api-worker".

Names must be 1-32 characters, letters/numbers/hyphens/underscores only. Must be unique.

### 6. Open the dashboard

```
http://localhost:7899
```

---

## CLI Commands

```bash
bun cli.ts status                         # Broker status + all peers
bun cli.ts peers                          # List all peers (with group info)
bun cli.ts send <name-or-id> <message>    # Send a message (resolves names)
bun cli.ts broadcast <scope> <message>    # Broadcast to machine/directory/repo
bun cli.ts groups                         # List isolation groups and members
bun cli.ts watch                          # Stream messages in real-time
bun cli.ts kill-broker                    # Stop the broker daemon
```

## MCP Tools

### Messaging

| Tool                | Description                                    |
| ------------------- | ---------------------------------------------- |
| `list_peers`        | Discover peers (scope: machine/directory/repo) |
| `send_message`      | Send to a peer by name or ID                   |
| `broadcast_message` | Send to all peers in a scope                   |
| `check_messages`    | Manually poll for messages                     |
| `ack_message`       | Acknowledge a received message                 |
| `check_acks`        | Check if sent messages were acknowledged       |
| `message_history`   | Retrieve past conversation with a peer         |
| `pin_message`       | Pin/unpin a message in the dashboard           |
| `react`             | Add/remove emoji reaction on a message         |

### Identity & Presence

| Tool                | Description                                    |
| ------------------- | ---------------------------------------------- |
| `set_name`          | Change your display name                       |
| `set_summary`       | Set work description (visible to peers)        |
| `set_status`        | Set presence: online/away/busy                 |

### Tasks

| Tool                | Description                                    |
| ------------------- | ---------------------------------------------- |
| `create_task`       | Create a task, optionally assign to a peer     |
| `complete_task`     | Mark a task as done with optional result        |
| `list_tasks`        | List tasks (filter by status)                  |

### Collaboration

| Tool                  | Description                                    |
| --------------------- | ---------------------------------------------- |
| `set_active_files`    | Report files you're editing (conflict detection)|
| `request_approval`    | Ask a peer to approve a dangerous action       |
| `respond_approval`    | Accept or reject an approval request           |
| `session_report`      | Generate a markdown session summary            |

## Dashboard Keyboard Shortcuts

| Shortcut       | Action                                |
| -------------- | ------------------------------------- |
| `Ctrl+K`       | Open command palette                  |
| `/`            | Focus message input                   |
| `Escape`       | Close palette / clear search          |
| `Enter`        | Send message (when input focused)     |
| `↑` `↓`        | Navigate command palette              |

## Dashboard Usage

### Groups

Peers are organized into **isolation groups**. Peers in different groups cannot see or message each other.

- **Create a group** — type a name in the sidebar Groups section and click "Create"
- **Assign peers** — use the dropdown on each peer card to move them between groups
- **Auto-grouping** — peers on the same git branch are automatically grouped into `branch/<name>` groups
- **Delete a group** — click × on the group header; members return to the lobby

### Tasks

The Tasks section in the sidebar shows a checkbox-style task board. Click the checkbox to mark tasks complete from the dashboard. Peers can create and assign tasks via MCP tools.

### Active Files

Shows which files each peer is currently editing. Files edited by multiple peers in the same group display a red **CONFLICT** badge.

### Pinned Messages

Click the 📌 button on any message bubble to pin it. Pinned messages appear in a dedicated bar above the chat. Click × to unpin.

### Reactions

Click an existing reaction chip on a message to add your own. Peers can add reactions via the `react` MCP tool. Hover to see who reacted.

### Session Reports

Open the command palette (`Ctrl+K`) and select "Session Report" to generate a structured markdown summary of the current session — participants, tasks, messages, approvals, and activity log.

### Translation

Click the "AR" button on any peer message to toggle Arabic translation. Translation is UI-only — stored messages are not modified.

### Theme

Click the sun/moon icon in the navbar to toggle dark/light mode. Preference is saved.

### Export

Click the download icon to export the current session's messages as a `.txt` file.

---

## LAN Access (Multi-Device)

The dashboard is accessible from any device on your network:

1. Find your machine's IP: `ipconfig` (Windows) or `ifconfig` (macOS/Linux)
2. Open `http://<your-ip>:7899` on your phone, tablet, or other computer
3. **Firewall**: You may need to allow port 7899 through your OS firewall:

   ```bash
   # Windows (run as Administrator):
   netsh advfirewall firewall add rule name="claude-peers" dir=in action=allow protocol=TCP localport=7899

   # macOS:
   # System Settings > Network > Firewall > allow port 7899

   # Linux:
   sudo ufw allow 7899/tcp
   ```

---

## Architecture

```
                    ┌─────────────────────────────┐
                    │  broker daemon               │
                    │  0.0.0.0:7899 + SQLite       │
                    │  + WebSocket (dashboard)      │
                    └──────┬──────────────────┬────┘
                           │                  │
                      MCP server A       MCP server B
                      (stdio)            (stdio)
                           │                  │
                      Claude A            Claude B
```

### Files

| File              | Purpose                                                    |
| ----------------- | ---------------------------------------------------------- |
| `broker.ts`       | HTTP + WebSocket server, SQLite persistence, all API logic |
| `server.ts`       | MCP stdio server per Claude instance, channel notifications|
| `cli.ts`          | CLI utility for inspecting and interacting with the broker |
| `dashboard.html`  | Real-time web UI — CSS + HTML structure                    |
| `dashboard.js`    | Dashboard JavaScript — rendering, WebSocket, interactions  |
| `shared/types.ts` | TypeScript type definitions                                |
| `shared/log.ts`   | Structured logging with timestamps and levels              |
| `broker.test.ts`  | Test suite (22 tests covering all features)                |

### Database Tables

| Table              | Purpose                              |
| ------------------ | ------------------------------------ |
| `peers`            | Registered peer instances            |
| `messages`         | All messages (with pinned flag)      |
| `isolation_groups` | Named isolation groups               |
| `tasks`            | Task delegation and tracking         |
| `approvals`        | Approval request/response records    |
| `reactions`        | Emoji reactions on messages          |
| `audit_log`        | Action audit trail                   |
| `kv`               | Key-value store (session ID, etc.)   |

## Configuration

| Variable                      | Default              | Description                             |
| ----------------------------- | -------------------- | --------------------------------------- |
| `CLAUDE_PEERS_PORT`           | `7899`               | Broker port                             |
| `CLAUDE_PEERS_DB`             | `~/.claude-peers.db` | SQLite database path                    |
| `CLAUDE_PEERS_SKIP_PID_CHECK` | `0`                  | Skip process liveness checks (testing)  |
| `LOG_LEVEL`                   | `info`               | Log verbosity: debug, info, warn, error |

## Testing

```bash
bun test broker
```

Runs 22 tests covering: slot-based naming, session persistence, group isolation, auto-grouping, tasks, pinning, active file conflicts, reactions, approvals, audit logging, graceful shutdown.

## Requirements

- [Bun](https://bun.sh) runtime
- Claude Code v2.1.80+
- claude.ai login (channels require OAuth — API key auth won't work)

## Troubleshooting

**"Failed to reconnect to claude-peers"**

- Check the MCP server path: `claude mcp list --scope user`
- Ensure the path to `server.ts` is an absolute path, not relative

**Messages not appearing in the other session**

- Both sessions must use `--dangerously-load-development-channels server:claude-peers`
- Check broker is running: `bun cli.ts status`

**Dashboard shows "No peers"**

- Refresh the page — the initial WebSocket may not have connected yet
- Check broker health: `curl http://localhost:7899/health`

**Peers keep getting renamed (claude-7, claude-8...)**

- This was fixed with slot-based naming. Kill the broker and restart: `bun cli.ts kill-broker`
- Delete the old database if needed: `rm ~/.claude-peers.db`

**Messages disappear when one peer disconnects**

- This was fixed with session persistence. The session only resets when all peers have been gone for 5+ minutes.
- Kill the broker and restart to pick up the fix

**Can't access dashboard from phone**

- Ensure broker is bound to `0.0.0.0` (default in this fork)
- Open port 7899 in your firewall (see LAN Access section above)

**kill-broker doesn't work on Windows**

- Run from an elevated terminal if `taskkill` fails with access denied

---

_Based on [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) by louislva._
