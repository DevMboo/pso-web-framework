import { Injectable, log, type OnReady, type OnShutdown } from "@pso/http";

/**
 * Lifecycle hook "startup".
 *
 *   onReady      runs once, after start-up succeeded and the listener is bound, just before the application reports ready.
 *                Throwing (or rejecting) stops start-up: nothing stays running.
 *   onShutdown   runs once during shutdown, after the running requests finished and before the framework releases its resources.
 *
 * A hook is a provider with a lifecycle: it runs only when a module lists this class in `providers` of its MODULE.pso.ts
 * (`pso make:hook startup --module <module>` adds it). A file in src/hooks/ is never run on its own.
 */
@Injectable()
export class StartupHook implements OnReady, OnShutdown {
  async onReady(): Promise<void> {
    log("info", "hook ready", { component: "startup" });
  }

  async onShutdown(): Promise<void> {
    log("info", "hook stopped", { component: "startup" });
  }
}
