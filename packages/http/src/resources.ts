import { log } from "./logger.ts";

/**
 * Ownership of what start-up acquired (connections, consumers, timers, the listener). Each resource is released at most once, a release
 * is bounded in time and never throws: a failure or a timeout is logged and the remaining resources are still released.
 *
 * Start-up that fails after acquiring something calls releaseAll() (newest first), so a failed start never leaves a connection, a
 * consumer or a listener behind. Shutdown releases by name in its documented order, then releaseAll() for whatever is left.
 */
interface Item { name: string; release: () => unknown; done?: Promise<boolean> }

export class OwnedResources {
  readonly #items: Item[] = [];
  readonly #timeoutMs: number;

  constructor(timeoutMs = 15_000) { this.#timeoutMs = timeoutMs; }

  /** Registers a resource that was acquired successfully. `release` may be called while the resource is only partly started. */
  add(name: string, release: () => unknown): void { this.#items.push({ name, release }); }

  /** Names not released yet, in acquisition order. */
  get pending(): string[] { return this.#items.filter((i) => !i.done).map((i) => i.name); }

  #run(item: Item): Promise<boolean> {
    return (item.done ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timedOut = await Promise.race([
          Promise.resolve().then(() => item.release()).then(() => false),
          new Promise<boolean>((r) => { timer = setTimeout(() => r(true), this.#timeoutMs); timer.unref(); }),
        ]);
        if (timedOut) log("warn", "resource release timed out; continuing", { component: "lifecycle", resource: item.name, timeoutMs: this.#timeoutMs });
        return !timedOut;
      } catch (e) {
        log("warn", "resource release failed; continuing", { component: "lifecycle", resource: item.name, error: e instanceof Error ? e.name : "error" }); // the message can carry a URL: only the type is logged
        return false;
      } finally { if (timer) clearTimeout(timer); }
    })());
  }

  /** Releases every resource registered under `name` (newest first). Safe to call repeatedly and for names that were never acquired. */
  async release(name: string): Promise<void> {
    for (const item of [...this.#items].reverse()) if (item.name === name) await this.#run(item);
  }

  /** Releases everything not released yet, newest first. Returns the names whose release failed or timed out. */
  async releaseAll(): Promise<string[]> {
    const failed: string[] = [];
    for (const item of [...this.#items].reverse()) if (!(await this.#run(item))) failed.push(item.name);
    return [...new Set(failed)];
  }
}
