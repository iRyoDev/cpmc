# claude-peers

Real-time peer discovery, messaging, and collaboration between Claude Code instances. Run multiple sessions across different projects — any Claude can discover the others, send messages, and coordinate work instantly.

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
- **Auto-naming** — peers get friendly names (claude-1, claude-2) instead of random IDs
- **Name resolution** — send messages by name (`send_message("claude-2", "hello")`)
- **Broadcast messaging** — send to all peers by scope (machine/directory/repo)
- **Message acknowledgment** — track delivery and read receipts
- **Peer groups** — join/leave named rooms, send to group members
- **Message history** — retrieve past conversations with any peer
- **Session management** — new session starts when all peers disconnect; old messages hidden

### Web Dashboard (http://localhost:7899)

- **Real-time WebSocket updates** — no polling, instant state sync
- **Chat-style message feed** with sender/receiver bubbles, Markdown rendering
- **Sidebar** with peer list (status indicators, presence, typing), groups, search
- **Compose bar** with peer selector, Enter-to-send, character counter
- **Dark/light theme toggle** — persisted across sessions
- **Arabic translation toggle** — translates Claude messages to Arabic (UI-only)
- **Group management** — join/leave groups from the dashboard
- **Export chat** — download session messages as text
- **Copy peer ID** — click to copy from sidebar
- **LAN accessible** — open from any device on your network
- **Fully responsive** — mobile slide-over sidebar, tablet, desktop, 4K scaling

### Presence & Status

- **Online/away/busy/idle** status per peer (`set_status` tool)
- **Typing indicators** — animated dots when a peer is typing
- **Status badges** in sidebar with color coding

### Developer Tools

- **Structured logging** with timestamps and levels (`LOG_LEVEL=debug`)
- **CLI interactive mode** (`bun cli.ts watch`) — stream messages in real-time
- **CLI name resolution** — `bun cli.ts send claude-2 hello`
- **Database indices** for fast queries on large message volumes
- **Message expiration** — delivered messages older than 24h auto-cleaned
- **Input validation** — rate limiting (10 msg/min), message size (64KB), name rules
- **Auto-reconnect** — MCP server reconnects to broker after failures

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
bun cli.ts peers                          # List all peers
bun cli.ts send <name-or-id> <message>    # Send a message (resolves names)
bun cli.ts broadcast <scope> <message>    # Broadcast to machine/directory/repo
bun cli.ts groups                         # List all groups
bun cli.ts watch                          # Stream messages in real-time
bun cli.ts kill-broker                    # Stop the broker daemon
```

## MCP Tools

| Tool                | Description                                    |
| ------------------- | ---------------------------------------------- |
| `list_peers`        | Discover peers (scope: machine/directory/repo) |
| `send_message`      | Send to a peer by name or ID                   |
| `broadcast_message` | Send to all peers in a scope                   |
| `set_name`          | Change your display name                       |
| `set_summary`       | Set work description (visible to peers)        |
| `set_status`        | Set presence: online/away/busy                 |
| `check_messages`    | Manually poll for messages                     |
| `ack_message`       | Acknowledge a received message                 |
| `check_acks`        | Check if sent messages were acknowledged       |
| `message_history`   | Retrieve past conversation with a peer         |
| `join_group`        | Join a named group/room                        |
| `leave_group`       | Leave a group                                  |
| `send_to_group`     | Message all group members                      |
| `list_groups`       | List groups and member counts                  |

## Dashboard Usage

### Sending Messages

Select a peer from the dropdown, type a message, press Enter or click Send.

### Search

Use the search box in the sidebar to filter messages by content or sender name.

### Groups

Type a group name in the sidebar input and click "Join". Click × on a group chip to leave. Select a group as the recipient in the compose bar to message all members.

### Translation

Click the "AR" button in the navbar to toggle Arabic translation. Only peer messages are translated (your own stay as-is). Translation is UI-only — stored messages are not modified.

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
   # System Settings → Network → Firewall → allow port 7899

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

- **broker.ts** — HTTP + WebSocket server, SQLite persistence, peer/message/group management
- **server.ts** — MCP stdio server per Claude instance, polls broker, pushes channel notifications
- **cli.ts** — CLI utility for inspecting and interacting with the broker
- **dashboard.html** — Real-time web UI served by the broker
- **shared/types.ts** — TypeScript type definitions
- **shared/log.ts** — Structured logging with timestamps and levels

## Configuration

| Variable            | Default              | Description                             |
| ------------------- | -------------------- | --------------------------------------- |
| `CLAUDE_PEERS_PORT` | `7899`               | Broker port                             |
| `CLAUDE_PEERS_DB`   | `~/.claude-peers.db` | SQLite database path                    |
| `LOG_LEVEL`         | `info`               | Log verbosity: debug, info, warn, error |

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

**Can't access dashboard from phone**

- Ensure broker is bound to `0.0.0.0` (default in this fork)
- Open port 7899 in your firewall (see LAN Access section above)

**kill-broker doesn't work on Windows**

- Run from an elevated terminal if `taskkill` fails with access denied

---

_Based on [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) by louislva._
