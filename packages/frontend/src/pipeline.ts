import { isSafeRedirect } from "./validate.ts";
import type { MiddlewareDefinition, NavigationContext, NavigationOutcome, NavigationTarget } from "./contracts.ts";

/**
 * The navigation middleware pipeline.
 *
 * Browser middleware is a USER-EXPERIENCE mechanism: it decides what the interface shows. It is not a security boundary: anything it
 * "denies" is still reachable by a person using the browser's developer tools, so the orchestrator and the services enforce every
 * scope, tenant rule and business rule again.
 */
export class PipelineError extends Error {
  readonly middleware: string;
  constructor(middleware: string, cause: unknown) {
    super(`middleware "${middleware}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PipelineError";
    this.middleware = middleware;
    this.cause = cause;
  }
}
export class NavigationCancelled extends Error { constructor() { super("navigation cancelled"); this.name = "NavigationCancelled"; } }

export interface PipelineResult { outcome: NavigationOutcome; /** values published by the middlewares (read-only snapshot) */ values: Readonly<Record<string, unknown>>; /** the middlewares that ran, in order */ trace: string[] }

const CONTINUE: NavigationOutcome = { type: "continue" };

/** The shared value store. FEI middlewares write it; MEI middlewares can only read it and write under their own namespace. */
function makeContext(to: NavigationTarget, from: string | undefined, signal: AbortSignal, store: Map<string, unknown>, writable: (key: string) => boolean, who: string): NavigationContext {
  return {
    kind: "navigation",
    to: Object.freeze({ ...to, params: Object.freeze({ ...to.params }), query: Object.freeze({ ...to.query }), scopes: Object.freeze([...to.scopes]) }) as NavigationTarget,
    ...(from !== undefined ? { from } : {}),
    signal,
    get: <T,>(key: string) => store.get(key) as T | undefined,
    set(key, value) {
      if (!writable(key)) throw new Error(`middleware "${who}" may not write "${key}": a MEI middleware writes only under "mei.<name>."`);
      store.set(key, value);
    },
    redirect(path) {
      if (!isSafeRedirect(path)) throw new Error(`redirect to "${path}" refused: only paths inside this application are allowed`);
      return { type: "redirect", to: path };
    },
    deny: (status, reason) => ({ type: "denied", status, reason }),
  };
}

async function run(chain: ReadonlyArray<MiddlewareDefinition>, mk: (who: string) => NavigationContext, trace: string[], signal: AbortSignal, terminal: () => Promise<NavigationOutcome>): Promise<NavigationOutcome> {
  let called = -1;
  const dispatch = async (i: number): Promise<NavigationOutcome> => {
    if (signal.aborted) throw new NavigationCancelled();
    if (i <= called) throw new Error(`next() called twice in "${chain[i - 1]?.name ?? "?"}"`);
    called = i;
    const mw = chain[i];
    if (!mw) return terminal();
    trace.push(mw.name);
    try {
      const out = await mw.execute(mk(mw.name), () => dispatch(i + 1));
      if (signal.aborted) throw new NavigationCancelled();
      if (!out || typeof out !== "object" || !("type" in out)) throw new Error("it must return the result of next(), redirect() or deny()");
      if (out.type === "redirect" && !isSafeRedirect(out.to)) throw new Error(`redirect to "${out.to}" refused`);
      return out;
    } catch (e) {
      if (e instanceof NavigationCancelled || e instanceof PipelineError) throw e;
      throw new PipelineError(mw.name, e);
    }
  };
  return dispatch(0);
}

export interface PipelineInput {
  /** mandatory, in the order the FEI declared them */
  host: ReadonlyArray<MiddlewareDefinition>;
  /** domain middleware of the MEI that owns the destination; they run only after the host pipeline allowed the navigation */
  domain?: { name: string; middlewares: ReadonlyArray<MiddlewareDefinition> };
  to: NavigationTarget;
  from?: string;
  signal?: AbortSignal;
  /** values already known (session, locale...) */
  initial?: Record<string, unknown>;
}

/**
 * Runs the host pipeline, then the MEI's own middleware. A MEI middleware:
 *  - cannot be placed before or between the mandatory ones (it runs only if they continued),
 *  - cannot overwrite what they published (it may write only under `mei.<name>.`),
 *  - can deny, or redirect inside its own mount path; it can never turn a denial into a continuation.
 */
export async function runNavigation(input: PipelineInput): Promise<PipelineResult> {
  const signal = input.signal ?? new AbortController().signal;
  const store = new Map<string, unknown>(Object.entries(input.initial ?? {}));
  const trace: string[] = [];
  const hostCtx = (who: string) => makeContext(input.to, input.from, signal, store, () => true, who);
  const domain = input.domain;
  const terminal = async (): Promise<NavigationOutcome> => {
    if (!domain || domain.middlewares.length === 0) return CONTINUE;
    const ns = `mei.${domain.name}.`;
    const out = await run(domain.middlewares, (who) => makeContext(input.to, input.from, signal, store, (k) => k.startsWith(ns), who), trace, signal, async () => CONTINUE);
    if (out.type === "redirect") {
      const mount = input.to.owner ? input.to.path.split("/").slice(0, 2).join("/") : "";
      if (!(out.to === mount || out.to.startsWith(`${mount}/`))) throw new PipelineError(domain.name, new Error(`a MEI middleware may only redirect inside its own mount path (${mount})`));
    }
    return out;
  };
  const outcome = await run(input.host, hostCtx, trace, signal, terminal);
  return { outcome, values: Object.freeze(Object.fromEntries(store)), trace };
}
