import { topoOrder } from "./graph.ts";

export type State = "DISCOVERED" | "VALIDATED" | "REGISTERED" | "INITIALIZED" | "READY" | "STOPPING" | "STOPPED" | "FAILED";

const NEXT: Record<State, State[]> = {
  DISCOVERED: ["VALIDATED", "FAILED"],
  VALIDATED: ["REGISTERED", "FAILED"],
  REGISTERED: ["INITIALIZED", "FAILED"],
  INITIALIZED: ["READY", "STOPPING", "FAILED"],
  READY: ["STOPPING", "FAILED"],
  STOPPING: ["STOPPED", "FAILED"],
  STOPPED: [],
  FAILED: ["STOPPING", "STOPPED", "REGISTERED"], // REGISTERED = controlled recovery via retry()
};

export interface Managed {
  id: string;
  dependsOn?: string[];
  init(): Promise<void> | void;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export interface Entry {
  state: State;
  error?: string;
}

export class LifecycleError extends Error {
  readonly code = "PSO_LIFECYCLE";
}

/**
 * Starts resources dependency-first and stops them in reverse. If one fails, everything already
 * brought up is stopped again and dependents are marked FAILED with the cause, so the registry never
 * reports a READY resource whose dependency is not READY.
 */
export class LifecycleManager {
  private readonly items = new Map<string, Managed>();
  private readonly entries = new Map<string, Entry>();

  register(m: Managed): void {
    if (this.items.has(m.id)) throw new LifecycleError(`Duplicate resource "${m.id}"`);
    this.items.set(m.id, m);
    this.entries.set(m.id, { state: "DISCOVERED" });
    this.move(m.id, "VALIDATED");
    this.move(m.id, "REGISTERED");
  }

  state(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new LifecycleError(`Unknown resource "${id}"`);
    return { ...e };
  }

  snapshot(): Record<string, Entry> {
    return Object.fromEntries([...this.entries].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, { ...v }]));
  }

  private move(id: string, to: State): void {
    const e = this.entries.get(id)!;
    if (!NEXT[e.state].includes(to)) throw new LifecycleError(`${id}: illegal transition ${e.state} -> ${to}`);
    e.state = to;
    if (to !== "FAILED") delete e.error;
  }

  private order(): string[] {
    const edges = new Map<string, string[]>();
    for (const [id, m] of this.items) edges.set(id, m.dependsOn ?? []);
    try {
      return topoOrder(edges);
    } catch (e) {
      throw new LifecycleError((e as Error).message);
    }
  }

  async start(): Promise<void> {
    const order = this.order();
    const brought: string[] = [];
    for (const id of order) {
      const m = this.items.get(id)!;
      const e = this.entries.get(id)!;
      if (e.state !== "REGISTERED") continue;
      const badDep = (m.dependsOn ?? []).find((d) => this.entries.get(d)!.state !== "READY");
      if (badDep) { this.fail(id, `dependency "${badDep}" is not ready`); continue; }
      try {
        await m.init();
        this.move(id, "INITIALIZED");
        await m.start?.();
        this.move(id, "READY");
        brought.push(id);
      } catch (err) {
        this.fail(id, (err as Error).message);
        for (const b of brought.reverse()) await this.stopOne(b); // roll back, newest first
        throw new LifecycleError(`Start failed at "${id}": ${(err as Error).message}`);
      }
    }
  }

  private fail(id: string, error: string): void {
    const e = this.entries.get(id)!;
    if (NEXT[e.state].includes("FAILED")) {
      e.state = "FAILED";
      e.error = error;
    }
  }

  private async stopOne(id: string): Promise<void> {
    const e = this.entries.get(id)!;
    if (e.state === "STOPPED" || e.state === "FAILED") return;
    try {
      this.move(id, "STOPPING");
      await this.items.get(id)!.stop?.();
      this.move(id, "STOPPED");
    } catch (err) {
      this.fail(id, `stop failed: ${(err as Error).message}`);
    }
  }

  /** Dependents stop before their dependencies. A failure in one stop never prevents the others. */
  async stop(): Promise<void> {
    for (const id of [...this.order()].reverse()) {
      const s = this.entries.get(id)!.state;
      if (s === "READY" || s === "INITIALIZED") await this.stopOne(id);
    }
  }

  /** Controlled recovery: FAILED -> REGISTERED so start() can be attempted again. */
  retry(id: string): void {
    this.move(id, "REGISTERED");
  }
}
