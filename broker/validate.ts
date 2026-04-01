/**
 * broker/validate.ts — Input validation for broker API requests
 *
 * Completely standalone — no dependencies on broker state or database.
 * All validators throw ValidationError on invalid input (caught as HTTP 400 by the router).
 */

import type {
  RegisterRequest,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  BroadcastRequest,
  AckMessageRequest,
  CheckAcksRequest,
  SetNameRequest,
  SetStatusRequest,
  MessageHistoryRequest,
} from "../shared/types.ts";

export const STRUCTURED_MSG_TYPES = ["question", "decision", "context_share", "review_request", "handoff"];

export class ValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ValidationError";
  }
}

export function validateString(val: unknown, name: string): string {
  if (typeof val !== "string" || val.length === 0)
    throw new ValidationError(`'${name}' must be a non-empty string`);
  return val;
}

export function validateOptionalString(val: unknown, name: string): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val !== "string")
    throw new ValidationError(`'${name}' must be a string or null`);
  return val;
}

export function validateNumber(val: unknown, name: string): number {
  if (typeof val !== "number" || !Number.isFinite(val))
    throw new ValidationError(`'${name}' must be a finite number`);
  return val;
}

export function validateBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object")
    throw new ValidationError("Invalid request body");
  return body as Record<string, unknown>;
}

function validateOptionalStringArray(val: unknown, name: string): string[] | undefined {
  if (val === null || val === undefined) return undefined;
  if (!Array.isArray(val)) throw new ValidationError(`'${name}' must be an array`);
  return val.filter((v: unknown) => typeof v === "string") as string[];
}

// --- Request validators ---

export function validateRegisterRequest(raw: unknown): RegisterRequest & { git_branch?: string | null } {
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

export function validateHeartbeatRequest(raw: unknown): HeartbeatRequest {
  const b = validateBody(raw);
  return { id: validateString(b.id, "id") };
}

export function validateSetSummaryRequest(raw: unknown): SetSummaryRequest {
  const b = validateBody(raw);
  return {
    id: validateString(b.id, "id"),
    summary: validateString(b.summary, "summary"),
  };
}

export function validateListPeersRequest(raw: unknown): ListPeersRequest {
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

export function validateSendMessageRequest(raw: unknown): SendMessageRequest {
  const b = validateBody(raw);
  return {
    from_id: validateString(b.from_id, "from_id"),
    to_id: validateString(b.to_id, "to_id"),
    text: validateString(b.text, "text"),
  };
}

export function validatePollMessagesRequest(raw: unknown): PollMessagesRequest {
  const b = validateBody(raw);
  return { id: validateString(b.id, "id") };
}

export function validateUnregisterRequest(raw: unknown): { id: string } {
  const b = validateBody(raw);
  return { id: validateString(b.id, "id") };
}

export function validateBroadcastRequest(raw: unknown): BroadcastRequest {
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

export function validateAckMessageRequest(raw: unknown): AckMessageRequest {
  const b = validateBody(raw);
  return {
    id: validateString(b.id, "id"),
    message_id: validateNumber(b.message_id, "message_id"),
  };
}

export function validateCheckAcksRequest(raw: unknown): CheckAcksRequest {
  const b = validateBody(raw);
  return {
    from_id: validateString(b.from_id, "from_id"),
    limit: typeof b.limit === "number" ? b.limit : undefined,
  };
}

export function validateSetNameRequest(raw: unknown): SetNameRequest {
  const b = validateBody(raw);
  return {
    id: validateString(b.id, "id"),
    name: validateString(b.name, "name"),
  };
}

export function validateSetStatusRequest(raw: unknown): SetStatusRequest {
  const b = validateBody(raw);
  const status = b.status;
  if (status !== "online" && status !== "away" && status !== "busy" && status !== "idle")
    throw new ValidationError("'status' must be 'online', 'away', 'busy', or 'idle'");
  return { id: validateString(b.id, "id"), status };
}

export function validateSetTypingRequest(raw: unknown): { id: string } {
  const b = validateBody(raw);
  return { id: validateString(b.id, "id") };
}

export function validateMessageHistoryRequest(raw: unknown): MessageHistoryRequest {
  const b = validateBody(raw);
  return {
    peer_a: validateString(b.peer_a, "peer_a"),
    peer_b: validateString(b.peer_b, "peer_b"),
    limit: typeof b.limit === "number" ? b.limit : undefined,
  };
}

// --- Validators for newer endpoints ---

export function validateSendStructuredRequest(raw: unknown): {
  from_id: string; to_id: string; msg_type: string;
  context_snapshot?: string | null;
  [key: string]: unknown;
} {
  const b = validateBody(raw);
  const msgType = validateString(b.msg_type, "msg_type");
  if (!STRUCTURED_MSG_TYPES.includes(msgType))
    throw new ValidationError(`'msg_type' must be one of: ${STRUCTURED_MSG_TYPES.join(", ")}`);
  return {
    ...b,
    from_id: validateString(b.from_id, "from_id"),
    to_id: validateString(b.to_id, "to_id"),
    msg_type: msgType,
    context_snapshot: validateOptionalString(b.context_snapshot, "context_snapshot"),
  };
}

export function validatePostDecisionRequest(raw: unknown): { author_id: string; key: string; value: string; rationale: string; category?: string } {
  const b = validateBody(raw);
  return {
    author_id: validateString(b.author_id, "author_id"),
    key: validateString(b.key, "key"),
    value: validateString(b.value, "value"),
    rationale: validateString(b.rationale, "rationale"),
    category: typeof b.category === "string" ? b.category : undefined,
  };
}

export function validateListDecisionsRequest(raw: unknown): { key?: string; category?: string; status?: string } {
  const b = validateBody(raw);
  return {
    key: typeof b.key === "string" ? b.key : undefined,
    category: typeof b.category === "string" ? b.category : undefined,
    status: typeof b.status === "string" ? b.status : undefined,
  };
}

export function validateRevokeDecisionRequest(raw: unknown): { decision_id: string; peer_id: string } {
  const b = validateBody(raw);
  return {
    decision_id: validateString(b.decision_id, "decision_id"),
    peer_id: validateString(b.peer_id, "peer_id"),
  };
}

export function validateRequestVerificationRequest(raw: unknown): { requester_id: string; verifier_id: string; claim: string; evidence_needed: string; files_to_check?: string[] } {
  const b = validateBody(raw);
  return {
    requester_id: validateString(b.requester_id, "requester_id"),
    verifier_id: validateString(b.verifier_id, "verifier_id"),
    claim: validateString(b.claim, "claim"),
    evidence_needed: typeof b.evidence_needed === "string" ? b.evidence_needed : "",
    files_to_check: validateOptionalStringArray(b.files_to_check, "files_to_check"),
  };
}

export function validateRespondVerificationRequest(raw: unknown): { verification_id: string; verifier_id: string; status: string; response: string; evidence?: string } {
  const b = validateBody(raw);
  const status = validateString(b.status, "status");
  if (status !== "verified" && status !== "failed")
    throw new ValidationError("'status' must be 'verified' or 'failed'");
  return {
    verification_id: validateString(b.verification_id, "verification_id"),
    verifier_id: validateString(b.verifier_id, "verifier_id"),
    status,
    response: validateString(b.response, "response"),
    evidence: typeof b.evidence === "string" ? b.evidence : undefined,
  };
}

export function validateListVerificationsRequest(raw: unknown): { peer_id?: string; status?: string } {
  const b = validateBody(raw);
  return {
    peer_id: typeof b.peer_id === "string" ? b.peer_id : undefined,
    status: typeof b.status === "string" ? b.status : undefined,
  };
}

export function validateCreateProposalRequest(raw: unknown): { author_id: string; title: string; description?: string; required_votes?: number } {
  const b = validateBody(raw);
  return {
    author_id: validateString(b.author_id, "author_id"),
    title: validateString(b.title, "title"),
    description: typeof b.description === "string" ? b.description : undefined,
    required_votes: typeof b.required_votes === "number" ? b.required_votes : undefined,
  };
}

export function validateVoteProposalRequest(raw: unknown): { proposal_id: string; voter_id: string; vote: string; reason?: string } {
  const b = validateBody(raw);
  const vote = validateString(b.vote, "vote");
  if (vote !== "approve" && vote !== "reject")
    throw new ValidationError("'vote' must be 'approve' or 'reject'");
  return {
    proposal_id: validateString(b.proposal_id, "proposal_id"),
    voter_id: validateString(b.voter_id, "voter_id"),
    vote,
    reason: typeof b.reason === "string" ? b.reason : undefined,
  };
}

export function validateListProposalsRequest(raw: unknown): { status?: string } {
  const b = validateBody(raw);
  return {
    status: typeof b.status === "string" ? b.status : undefined,
  };
}
