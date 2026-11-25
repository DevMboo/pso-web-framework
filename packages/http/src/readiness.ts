/**
 * Readiness of ONE orchestrator instance: "may this instance receive traffic for what it is configured to do?".
 *
 *  - liveness (/health/live) is separate and never looks at dependencies: a broker outage must not restart the process;
 *  - a REQUIRED dependency that is down makes the instance not ready (503); an OPTIONAL one is reported and the instance stays ready;
 *  - upstream services are NOT readiness dependencies: one unavailable service must not take every gateway instance out of rotation
 *    (requests to it already answer 503 on their own);
 *  - probes run in the background on an interval, are bounded in time and never overlap; a request to /health/ready only reads the
 *    cached result, so probing costs nothing per request and a slow dependency cannot slow the endpoint down;
 *  - a dependency is reported DOWN after `failureThreshold` consecutive failed probes (one blip does not flap the instance) and UP again
 *    on the first successful probe.
 */
export type CheckStatus = "UP" | "DOWN" | "UNKNOWN";
export interface ProbeResult { up: boolean; detail?: string }
export interface DependencyCheck { name: string; required: boolean; probe: () => Promise<ProbeResult> | ProbeResult }
export interface CheckReport { status: CheckStatus; required: boolean; detail?: string }
export interface ReadinessReport { status: "UP" | "DOWN"; state: string; checks: Record<string, CheckReport> }
export interface ReadinessOptions { intervalMs?: number; timeoutMs?: number; failureThreshold?: number; state: () => string; onChange?: (name: string, report: CheckReport) => void }

/** Diagnostics are for operators but the endpoint is public: no URLs (they can carry credentials or topology), bounded length. */
export const safeDetail = (s: string | undefined): string | undefined =>
  s === undefined ? undefined : s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "(address hidden)").replace(/[\r\n]+/g, " ").slice(0, 160);

interface Entry { check: DependencyCheck; status: CheckStatus; detail?: string; failures: number; running: boolean }

export class Readiness {
  readonly #entries: Entry[] = [];
  readonly #o: Required<Omit<ReadinessOptions, "onChange">> & Pick<ReadinessOptions, "onChange">;
  #timer: NodeJS.Timeout | undefined;

  constructor(o: ReadinessOptions) { this.#o = { intervalMs: o.intervalMs ?? 5000, timeoutMs: o.timeoutMs ?? 2000, failureThreshold: o.failureThreshold ?? 2, state: o.state, ...(o.onChange ? { onChange: o.onChange } : {}) }; }

  add(check: DependencyCheck): void { this.#entries.push({ check, status: "UNKNOWN", failures: 0, running: false }); }
  get size(): number { return this.#entries.length; }

  async #probe(e: Entry): Promise<void> {
    if (e.running) return; // a probe that is still pending is never stacked
    e.running = true;
    let timer: NodeJS.Timeout | undefined;
    let r: ProbeResult;
    try {
      r = await Promise.race([
        Promise.resolve().then(() => e.check.probe()),
        new Promise<ProbeResult>((res) => { timer = setTimeout(() => res({ up: false, detail: `probe timed out after ${this.#o.timeoutMs} ms` }), this.#o.timeoutMs); timer.unref(); }),
      ]);
    } catch (err) { r = { up: false, detail: `probe failed (${err instanceof Error ? err.name : "error"})` }; }
    finally { if (timer) clearTimeout(timer); e.running = false; }
    const before = e.status;
    if (r.up) { e.failures = 0; e.status = "UP"; }
    else { e.failures++; if (e.status === "UNKNOWN" || e.failures >= this.#o.failureThreshold) e.status = "DOWN"; } // the first probe decides; later ones need the threshold
    const detail = safeDetail(r.detail);
    if (r.up === (e.status === "UP")) { if (detail === undefined) delete e.detail; else e.detail = detail; } // the detail always describes the reported status (a blip below the threshold changes neither)
    if (before !== e.status) { try { this.#o.onChange?.(e.check.name, this.#reportOf(e)); } catch { /* an observer never breaks probing */ } }
  }

  /** Runs every probe once (concurrently, each bounded). Awaited before the instance first reports ready. */
  async probeNow(): Promise<void> { await Promise.all(this.#entries.map((e) => this.#probe(e))); }

  start(): void {
    if (this.#timer || this.#entries.length === 0) return;
    this.#timer = setInterval(() => { void this.probeNow(); }, this.#o.intervalMs);
    this.#timer.unref();
  }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }

  #reportOf(e: Entry): CheckReport { return { status: e.status, required: e.check.required, ...(e.detail !== undefined ? { detail: e.detail } : {}) }; }

  /** The cached answer. UP only when the instance finished starting, is not shutting down and no required dependency is down or unknown. */
  report(): ReadinessReport {
    const state = this.#o.state();
    const checks: Record<string, CheckReport> = {};
    for (const e of this.#entries) checks[e.check.name] = this.#reportOf(e);
    const blocked = this.#entries.some((e) => e.check.required && e.status !== "UP");
    return { status: state === "ready" && !blocked ? "UP" : "DOWN", state, checks };
  }
}
