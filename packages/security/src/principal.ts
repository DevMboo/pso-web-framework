import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The verified identity of the caller. Immutable. It deliberately does not carry the raw bearer token, so application code
 * cannot leak or replay it by accident.
 */
export class Principal {
  readonly subject: string;
  readonly issuer: string;
  readonly audiences: readonly string[];
  readonly scopes: readonly string[];
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly expiresAt: Date;
  readonly #scopes: ReadonlySet<string>;
  readonly #roles: ReadonlySet<string>;
  readonly #permissions: ReadonlySet<string>;

  constructor(d: { subject: string; issuer: string; audiences: string[]; scopes: string[]; roles: string[]; permissions: string[]; expiresAt: Date }) {
    this.subject = d.subject; this.issuer = d.issuer;
    this.audiences = Object.freeze([...d.audiences]); this.scopes = Object.freeze([...d.scopes]); this.roles = Object.freeze([...d.roles]); this.permissions = Object.freeze([...d.permissions]);
    this.expiresAt = new Date(d.expiresAt);
    this.#scopes = new Set(d.scopes); this.#roles = new Set(d.roles); this.#permissions = new Set(d.permissions);
    Object.freeze(this);
  }
  hasScope(s: string): boolean { return this.#scopes.has(s); }
  hasRole(r: string): boolean { return this.#roles.has(r); }
  hasPermission(p: string): boolean { return this.#permissions.has(p); }
  /** Safe to log: identity and grants, no token. */
  toJSON(): Record<string, unknown> { return { subject: this.subject, issuer: this.issuer, scopes: this.scopes, roles: this.roles, permissions: this.permissions }; }
}

// ------------------------------------------------------------ request-scoped context

interface Store { principal?: Principal }
const als = new AsyncLocalStorage<Store>();

/** Runs `fn` with a fresh, private security context. The framework wraps every request in one: identities never leak between concurrent requests. */
export function runInSecurityContext<T>(fn: () => T): T { return als.run({}, fn); }
export function setPrincipal(p: Principal): void {
  const s = als.getStore();
  if (!s) throw new Error("setPrincipal() called outside a request security context");
  s.principal = p;
}
/** The caller of the current request, or undefined on public routes and outside a request. */
export function currentPrincipal(): Principal | undefined { return als.getStore()?.principal; }
