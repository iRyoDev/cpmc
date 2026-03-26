// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export type PeerStatus = "online" | "away" | "busy" | "idle";

export interface Peer {
  id: PeerId;
  name: string; // human-friendly name, e.g. "claude-1"
  pid: number;
  cwd: string;
  git_root: string | null;
  git_branch: string | null;
  tty: string | null;
  summary: string;
  status: PeerStatus;
  group_id: string | null; // isolation group ID, null = lobby
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
  msg_type?: StructuredMessageType | null;
  metadata?: string | null; // JSON string of type-specific fields
  context_snapshot?: string | null; // JSON string of ContextSnapshot
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  git_branch?: string | null;
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

// --- Isolation Groups ---

export interface CreateGroupRequest {
  name: string;
}

export interface AssignGroupRequest {
  peer_id: PeerId;
  group_id: string | null;
}

export interface DeleteGroupRequest {
  group_id: string;
}

export interface IsolationGroup {
  id: string;
  name: string;
  member_count: number;
  members: Array<{ id: PeerId; name: string }>;
}

export interface ListIsolationGroupsResponse {
  groups: IsolationGroup[];
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

// --- Tasks ---

export interface Task {
  id: string;
  title: string;
  description: string;
  creator_id: PeerId;
  assignee_id: PeerId | null;
  group_id: string | null;
  status: "pending" | "in_progress" | "completed";
  result: string;
  created_at: string;
  completed_at: string | null;
  session_id: string;
}

// --- Active Files ---

export interface ActiveFilesEntry {
  peer_id: PeerId;
  peer_name: string;
  files: string[];
}

// --- Structured Messages ---

export type StructuredMessageType = "question" | "decision" | "context_share" | "review_request" | "handoff";

export interface ContextSnapshot {
  branch: string | null;
  recent_files: string[];
  summary: string;
  cwd: string;
}

// --- Decisions Board ---

export interface Decision {
  id: string;
  key: string;
  value: string;
  rationale: string;
  author_id: PeerId;
  author_name: string;
  category: string;
  status: "active" | "revoked";
  group_id: string | null;
  created_at: string;
  updated_at: string;
  session_id: string;
}

// --- Verification Protocol ---

export interface Verification {
  id: string;
  requester_id: PeerId;
  verifier_id: PeerId;
  claim: string;
  evidence_needed: string;
  files_to_check: string; // JSON array
  status: "pending" | "verified" | "failed";
  response: string;
  evidence: string;
  group_id: string | null;
  created_at: string;
  resolved_at: string | null;
  session_id: string;
}

// --- Consensus Protocol ---

export interface Proposal {
  id: string;
  author_id: PeerId;
  author_name: string;
  title: string;
  description: string;
  required_votes: number;
  status: "open" | "approved" | "rejected";
  group_id: string | null;
  created_at: string;
  resolved_at: string | null;
  session_id: string;
  votes: ProposalVote[];
}

export interface ProposalVote {
  id: string;
  proposal_id: string;
  voter_id: PeerId;
  voter_name: string;
  vote: "approve" | "reject";
  reason: string;
  created_at: string;
}
