import { log } from "./logger.ts";

/** What the process needs from the application to end it: close() and the time close() may take (see App.shutdown). */
export interface Closable { close(): Promise<void>; shutdown?: { graceMs: number; cleanupMs: number; deadlineMs: number } }

export interface ShutdownOptions {
  /** how the process ends; default process.exit */
  exit?: (code: number) => void;
  /** signals that start the shutdown; default SIGINT and SIGTERM (and SIGBREAK on Windows) */
  signals?: readonly string[];
  /** emergency deadline when the application does not state one (an App always does) */
  deadlineMs?: number;
}

export interface ShutdownHandle {
  /** the emergency deadline in effect: after this long the process is ended with a non-zero code even if close() has not returned */
  readonly deadlineMs: number;
  /** starts the shutdown (what a signal does); every later call returns the same run */
  trigger(reason: string): Promise<number>;
  /** removes the handlers (tests) */
  dispose(): void;
}

/**
 * Ends the process when it is asked to stop. One shutdown per process, however many signals arrive:
 *
 *   signal -> app.close() (stop accepting, let running requests finish within the grace period, release the dependents)
 *          -> exit 0 when close() returned, exit 1 when close() failed
 *   emergency deadline -> exit 1: close() did not return in the time it is allowed to take
 *
 * The emergency deadline is never a constant of its own: it is the application's configured request grace period plus the time allowed
 * for releasing the dependents (App.shutdown.deadlineMs), so the process is never ended while the grace period it was configured with
 * is still running, and it never hangs either.
 *
 * Windows has no SIGTERM: a console delivers SIGINT (Ctrl+C) or SIGBREAK, and a process manager that started the application with an
 * IPC channel sends the message "shutdown". All of them do the same thing here.
 */
export function shutdownOnSignals(app: Closable, opts: ShutdownOptions = {}): ShutdownHandle {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const deadlineMs = app.shutdown?.deadlineMs ?? opts.deadlineMs ?? 15_000;
  const signals = opts.signals ?? ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? ["SIGBREAK"] : [])];
  let run: Promise<number> | undefined;
  let repeats = 0;

  const trigger = (reason: string): Promise<number> => {
    if (run) { // a second signal never starts a second shutdown and never shortens the first
      if (++repeats === 1) log("info", "shutdown already in progress; the repeated request is ignored", { component: "lifecycle", sig: reason });
      return run;
    }
    const started = Date.now();
    log("info", "shutting down", { sig: reason, deadlineMs });
    return (run = new Promise<number>((done) => {
      let ended = false;
      const end = (code: number): void => { if (ended) return; ended = true; clearTimeout(emergency); done(code); exit(code); };
      // not unref'd: while a shutdown is running this timer is what guarantees the process ends
      const emergency = setTimeout(() => {
        log("error", "shutdown did not finish before its deadline; the process is ended now", { component: "lifecycle", deadlineMs, exitCode: 1 });
        end(1);
      }, deadlineMs);
      app.close().then(
        () => { log("info", "shutdown complete", { component: "lifecycle", tookMs: Date.now() - started, exitCode: 0 }); end(0); },
        (e: unknown) => { log("error", "shutdown failed", { component: "lifecycle", error: e instanceof Error ? e.name : "error", exitCode: 1 }); end(1); },
      );
    }));
  };

  const handlers = signals.map((sig) => { const h = (): void => { void trigger(sig); }; process.on(sig, h); return [sig, h] as const; });
  const onMessage = (m: unknown): void => { if (m === "shutdown") void trigger("shutdown message"); };
  if (typeof process.send === "function") process.on("message", onMessage);
  return { deadlineMs, trigger, dispose: () => { for (const [sig, h] of handlers) process.off(sig, h); process.off("message", onMessage); } };
}
