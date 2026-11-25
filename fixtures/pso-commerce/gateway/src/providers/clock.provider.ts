import { Injectable } from "@pso/http";

/**
 * Provider "clock": a class the framework constructs once per application and injects by constructor type.
 *
 * It exists for a module only when that module lists it in `providers` of its MODULE.pso.ts
 * (`pso make:provider clock --module <module>` adds it); a file in src/providers/ is never loaded on its own.
 * Constructor parameters are injected the same way: other providers of the module, Upstream, UpstreamClient, Dispatch.
 */
@Injectable()
export class ClockProvider {
}
