#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for managing the broker and inspecting peers.
 *
 * Usage:
 *   bun cli.ts status                        — Show broker status and all peers
 *   bun cli.ts peers                         — List all peers
 *   bun cli.ts send <id> <msg>               — Send a message to a peer
 *   bun cli.ts broadcast <scope> <msg>       — Broadcast to machine/directory/repo
 *   bun cli.ts groups                        — List all groups
 *   bun cli.ts kill-broker                   — Stop the broker daemon
 */

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);

      if (health.peers > 0) {
        const peers = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            cwd: string;
            git_root: string | null;
            tty: string | null;
            summary: string;
            last_seen: string;
          }>
        >("/list-peers", {
          scope: "machine",
          cwd: "/",
          git_root: null,
        });

        console.log("\nPeers:");
        for (const p of peers) {
          const name = (p as any).name ? `${(p as any).name} ` : "";
          const group = (p as any).group_id ? `[${(p as any).group_id}]` : "[lobby]";
          console.log(`  ${name}${p.id}  ${group}  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      const peers = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          cwd: string;
          git_root: string | null;
          tty: string | null;
          summary: string;
          last_seen: string;
        }>
      >("/list-peers", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });

      if (peers.length === 0) {
        console.log("No peers registered.");
      } else {
        for (const p of peers) {
          const group = (p as any).group_id ? `[${(p as any).group_id}]` : "[lobby]";
          const parts = [`${p.id}  ${group}  PID:${p.pid}  ${p.cwd}`];
          if ((p as any).name) parts[0] = `${(p as any).name} (${p.id})  ${group}  PID:${p.pid}  ${p.cwd}`;
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          console.log(parts.join("\n"));
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const toArg = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toArg || !msg) {
      console.error("Usage: bun cli.ts send <peer-name-or-id> <message>");
      process.exit(1);
    }
    try {
      // Resolve name to ID
      let toId = toArg;
      const peers = await brokerFetch<Array<{ id: string; name: string }>>("/list-peers", {
        scope: "machine", cwd: "/", git_root: null,
      });
      const byName = peers.find((p) => p.name === toArg);
      if (byName) toId = byName.id;

      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${byName ? byName.name : toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>("/health");
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);

      if (process.platform === "win32") {
        // Windows: parse netstat output to find PIDs listening on the broker port
        const proc = Bun.spawnSync(["netstat", "-ano"]);
        const output = new TextDecoder().decode(proc.stdout);
        const pids = new Set<string>();
        for (const line of output.split("\n")) {
          if (line.includes(`:${BROKER_PORT}`) && line.includes("LISTENING")) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && /^\d+$/.test(pid)) pids.add(pid);
          }
        }
        for (const pid of pids) {
          Bun.spawnSync(["taskkill", "/PID", pid, "/F"]);
        }
      } else {
        // Unix: use lsof to find PIDs on the port
        const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
        const pids = new TextDecoder()
          .decode(proc.stdout)
          .trim()
          .split("\n")
          .filter((p) => p);
        for (const pid of pids) {
          process.kill(parseInt(pid), "SIGTERM");
        }
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "broadcast": {
    const scope = process.argv[3] as "machine" | "directory" | "repo";
    const msg = process.argv.slice(4).join(" ");
    if (!scope || !msg) {
      console.error("Usage: bun cli.ts broadcast <machine|directory|repo> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; sent_to: number; error?: string }>("/broadcast", {
        from_id: "cli",
        scope,
        cwd: process.cwd(),
        git_root: null,
        text: msg,
      });
      if (result.ok) {
        console.log(`Broadcast sent to ${result.sent_to} peer(s)`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "groups": {
    try {
      const result = await brokerFetch<{ groups: Array<{ id: string; name: string; member_count: number; members: Array<{ id: string; name: string }> }> }>("/list-isolation-groups", {});
      if (result.groups.length === 0) {
        console.log("No isolation groups. All peers are in the lobby.");
      } else {
        for (const g of result.groups) {
          const memberNames = g.members.map((m) => m.name || m.id).join(", ");
          console.log(`  ${g.name} (${g.id})  ${g.member_count} member(s): ${memberNames || "none"}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "watch": {
    console.log("Connecting to broker WebSocket...");
    const proto = "ws:";
    const ws = new WebSocket(`${proto}//127.0.0.1:${BROKER_PORT}/ws`);
    let lastMsgId = 0;
    let nameMap: Record<string, string> = {};

    ws.addEventListener("open", () => {
      console.log("Connected. Watching messages in real-time. Press Ctrl+C to exit.\n");
    });
    ws.addEventListener("message", (ev) => {
      try {
        const d = JSON.parse(String(ev.data));
        // Build name map
        nameMap = { dashboard: "Dashboard", cli: "CLI" };
        for (const p of d.peers) nameMap[p.id] = p.name || p.id;
        // Show only new messages
        for (const m of d.messages) {
          if (m.id > lastMsgId) {
            const from = nameMap[m.from_id] || m.from_id;
            const to = nameMap[m.to_id] || m.to_id;
            const time = new Date(m.sent_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
            console.log(`  [${time}] ${from} \u2192 ${to}: ${m.text}`);
            lastMsgId = m.id;
          }
        }
      } catch { }
    });
    ws.addEventListener("close", () => {
      console.log("Disconnected from broker.");
      process.exit(0);
    });
    ws.addEventListener("error", () => {
      console.error("Failed to connect to broker. Is it running?");
      process.exit(1);
    });
    // Keep process alive
    await new Promise(() => { });
    break;
  }

  default:
    console.log(`claude-peers CLI

Usage:
  bun cli.ts status                         Show broker status and all peers
  bun cli.ts peers                          List all peers
  bun cli.ts send <name-or-id> <msg>        Send a message to a peer
  bun cli.ts broadcast <scope> <msg>        Broadcast to machine/directory/repo
  bun cli.ts groups                         List all groups
  bun cli.ts watch                          Stream messages in real-time
  bun cli.ts kill-broker                    Stop the broker daemon`);
}
