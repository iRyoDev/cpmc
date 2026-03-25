// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export type PeerStatus = "online" | "away" | "busy" | "idle";

export interface Peer {
  id: PeerId;
  name: string; // human-friendly name, e.g. "claude-1"
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  status: PeerStatus;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
  acknowledged: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
  name: string;
}

export interface SetNameRequest {
  id: PeerId;
  name: string;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

// --- Broadcast ---

export interface BroadcastRequest {
  from_id: PeerId;
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  text: string;
}

export interface BroadcastResponse {
  ok: boolean;
  sent_to: number;
  error?: string;
}

// --- Acknowledgment ---

export interface AckMessageRequest {
  id: PeerId;
  message_id: number;
}

export interface CheckAcksRequest {
  from_id: PeerId;
  limit?: number;
}

export interface CheckAcksResponse {
  messages: Message[];
}

// --- Peer Groups ---

export interface JoinGroupRequest {
  id: PeerId;
  group: string;
}

export interface LeaveGroupRequest {
  id: PeerId;
  group: string;
}

export interface SendToGroupRequest {
  from_id: PeerId;
  group: string;
  text: string;
}

export interface SendToGroupResponse {
  ok: boolean;
  sent_to: number;
  error?: string;
}

export interface ListGroupsResponse {
  groups: Array<{ name: string; member_count: number }>;
}

// --- Presence ---

export interface SetStatusRequest {
  id: PeerId;
  status: PeerStatus;
}

// --- Message History ---

export interface MessageHistoryRequest {
  peer_a: PeerId;
  peer_b: PeerId;
  limit?: number;
}

export interface MessageHistoryResponse {
  messages: Message[];
}
