/**
 * Application lifecycle hooks.
 *
 * A hook is a provider: a class listed in `providers` of a MODULE.pso.ts that implements `onReady`, `onShutdown` or both. Nothing is
 * discovered by directory or by name: a class that no module declares is never constructed and never called. Its constructor
 * dependencies are injected like those of any other provider (other providers of the module, `Upstream`, `UpstreamClient`, `Dispatch`).
 *
 *   onReady      called once, after every start-up step succeeded and the listener is bound, immediately BEFORE the application
 *                reports ready (`/health/ready` still answers 503 while hooks run). Hooks run one at a time, in module order and, inside
 *                a module, in the order of `providers`. A hook that throws or rejects stops start-up: everything that was acquired is
 *                released and the process does not become ready.
 *   onShutdown   called once during `close()`, after the requests that were running finished (or the grace period ended) and BEFORE
 *                the framework releases its own resources, so a hook can still use them. Reverse order of onReady. Only hooks whose
 *                onReady completed (or that have no onReady) are called. Bounded by the release timeout; a failure is logged and the
 *                shutdown continues.
 *
 * Hooks do not run with `bootstrap({ dryRun: true })`, and they are not request middleware: per-request behaviour belongs in a guard,
 * a middleware or a filter.
 */
export interface OnReady { onReady(): void | Promise<void> }
export interface OnShutdown { onShutdown(): void | Promise<void> }

export interface LifecycleHook { name: string; instance: Partial<OnReady & OnShutdown> }

/** True when a provider class takes part in the application lifecycle. */
export function isLifecycleProvider(cls: unknown): boolean {
  const proto = (cls as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  return typeof proto?.["onReady"] === "function" || typeof proto?.["onShutdown"] === "function";
}
