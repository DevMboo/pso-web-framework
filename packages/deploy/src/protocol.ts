import { canonical, sha256, signText, verifyText } from "./crypto.ts";

/**
 * The management protocol between a PSO client (CLI or Studio backend) and the runtime agent of an environment.
 *
 * Transport: newline-delimited JSON on the standard input/output of the agent process, which the client starts through an
 * authenticated SSH connection (or, for local development, as a child process). The agent never opens a network port, so there is no
 * management endpoint to publish by mistake.
 *
 * Trust: the agent proves its identity by signing a client-chosen challenge with an Ed25519 key that never leaves the server; the client
 * pins that key's fingerprint. The client proves its identity with its own Ed25519 key (enrolled once with a single-use token). Every
 * request after the handshake is signed over (session, sequence number, time, operation, hash of the arguments): a captured request
 * cannot be replayed (the sequence only grows) or altered (the hash is signed).
 */
export const PROTOCOL_VERSIONS = [1] as const;
export const AGENT_VERSION = "0.2.0"; // 0.2.0: static frontend resources (runtime "static", strategy static); protocol unchanged (1)

export const ROLES = ["viewer", "operator", "deployer", "admin", "superadmin"] as const;
export type Role = (typeof ROLES)[number];
export const roleRank = (r: Role): number => ROLES.indexOf(r);

/** Minimum role per operation. An operation that is not in this table does not exist: the agent is not a shell. */
export const OPERATIONS = {
  // unauthenticated (handshake)
  "hello": null, "enroll": null, "session.open": null,
  // viewer
  "whoami": "viewer", "session.close": "viewer", "inspect": "viewer", "service.status": "viewer", "release.list": "viewer", "release.status": "viewer",
  "trust.list": "viewer", "signature.verify": "viewer", "network.exposure": "viewer", "privilege.inspect": "viewer", "app.overview": "viewer", "services.runtime": "viewer", "endpoints.list": "viewer", "nginx.discover": "viewer", "nginx.read": "viewer", "nginx.backups": "viewer",
  "release.history": "viewer", "release.get": "viewer", "logs.read": "viewer", "proxy.status": "viewer", "policy.get": "viewer", "policy.compat": "viewer", "policy.history": "viewer", "release.plans": "viewer",
  // operator
  "app.config": "operator", "service.restart": "operator", "service.start": "operator", "service.stop": "operator",
  // deployer
  "artifact.begin": "deployer", "artifact.chunk": "deployer", "artifact.commit": "deployer", "release.propose": "deployer", "release.approve": "deployer",
  "release.start": "deployer", "release.cancel": "deployer", "release.rollback": "deployer", "release.recover": "deployer", "release.gc": "deployer",
  // admin
  "audit.read": "admin", "audit.verify": "admin", "client.list": "admin", "client.revoke": "admin", "enroll.create": "admin", "secret.set": "admin",
  "secret.list": "admin", "secret.remove": "admin", "provision.plan": "admin", "provision.apply": "admin",
  // superadmin
  "policy.set": "superadmin", "policy.migrate": "superadmin", "policy.revert": "superadmin", "client.role": "superadmin", "trust.add": "superadmin", "trust.revoke": "superadmin", "nginx.apply": "admin",
} as const satisfies Record<string, Role | null>;
export type OperationName = keyof typeof OPERATIONS;

export type ErrorCode = "BAD_REQUEST" | "UNKNOWN_OPERATION" | "UNAUTHENTICATED" | "FORBIDDEN" | "RATE_LIMITED" | "REPLAY" | "SESSION_EXPIRED" | "UNSUPPORTED_VERSION"
  | "NOT_PROVISIONED" | "ENROLLMENT_REFUSED" | "PLAN_STALE" | "POLICY" | "LOCKED" | "CONFLICT" | "NOT_FOUND" | "PRECONDITION" | "FAILED" | "INTERNAL";

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.code = code; }
}

export interface Request { v: number; id: number; op: string; args?: unknown; auth?: { sid: string; seq: number; ts: number; sig: string } }
export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: { code: ErrorCode; message: string } };

/** What a request signature covers. */
export const requestPayload = (sid: string, seq: number, ts: number, op: string, args: unknown): string => `pso-req\n${sid}\n${seq}\n${ts}\n${op}\n${sha256(canonical(args ?? null))}`;
export const signRequest = (privatePem: string, sid: string, seq: number, op: string, args: unknown): NonNullable<Request["auth"]> => {
  const ts = Date.now();
  return { sid, seq, ts, sig: signText(privatePem, requestPayload(sid, seq, ts, op, args)) };
};
export const verifyRequest = (publicPem: string, auth: NonNullable<Request["auth"]>, op: string, args: unknown): boolean => verifyText(publicPem, requestPayload(auth.sid, auth.seq, auth.ts, op, args), auth.sig);

export const helloPayload = (challenge: string, agentVersion: string, serverNonce: string): string => `pso-hello\n${challenge}\n${agentVersion}\n${serverNonce}`;
export const sessionPayload = (clientId: string, serverNonce: string, clientNonce: string): string => `pso-session\n${clientId}\n${serverNonce}\n${clientNonce}`;
export const enrollPayload = (tokenId: string, clientPublicKey: string, serverNonce: string): string => `pso-enroll\n${tokenId}\n${sha256(clientPublicKey)}\n${serverNonce}`;

export const REQUEST_SKEW_MS = 120_000;
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
