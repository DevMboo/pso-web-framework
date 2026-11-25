import "reflect-metadata";
import { log } from "./logger.ts";
import { StartupError, startupDiagnostics } from "./errors.ts";

// ---------- dependency injection (only validated, module-declared providers) ----------
/**
 * The framework's own injectable classes (Upstream, Dispatch, ChannelPublisher) carry a stable token as an own, non-enumerable
 * property. Instances are keyed by class identity, which is not the same object when a second physical copy of an @pso package is
 * loaded (a nested node_modules, a vendored copy, or on Windows the same files reached through a path that differs in the case of the
 * drive letter). Without the token such a class was unknown to the container, which then constructed a new, unconnected object.
 */
const DI_TOKEN = Symbol.for("pso.di.token");
interface DiToken { id: string; contract: number }
const tokenOf = (cls: unknown): DiToken | undefined => {
  if (typeof cls !== "function" || !Object.hasOwn(cls, DI_TOKEN)) return undefined; // own only: a subclass is its own class
  const t = (cls as unknown as Record<symbol, unknown>)[DI_TOKEN] as Partial<DiToken> | undefined;
  return t && typeof t.id === "string" && typeof t.contract === "number" ? { id: t.id, contract: t.contract } : undefined;
};
/** Gives a framework class its stable injection token (see above). */
export const defineDiToken = (cls: unknown, id: string, contract = 1): void => { Object.defineProperty(cls, DI_TOKEN, { value: { id, contract } }); };

/** One container per application (nothing global): instances by class, plus the tokens of the classes this application registered. */
export function makeContainer(builtins: Array<[unknown, unknown]>) {
  const instances = new Map<unknown, unknown>(builtins);
  const byToken = new Map<string, { contract: number; instance: unknown; name: string }>();
  for (const [cls, instance] of instances) { const t = tokenOf(cls); if (t) byToken.set(t.id, { contract: t.contract, instance, name: (cls as { name: string }).name }); }
  const reported = new Set<string>();
  const resolve_ = (cls: new (...a: never[]) => unknown, chain: unknown[] = []): unknown => {
    if (instances.has(cls)) return instances.get(cls);
    const token = tokenOf(cls);
    const registered = token ? byToken.get(token.id) : undefined;
    if (token && registered) {
      // the same framework class from ANOTHER copy of its package: never construct it; use this application's instance, or refuse
      if (registered.contract !== token.contract) throw new StartupError(`PSO_DI_INCOMPATIBLE: ${chain.length ? `${(chain[chain.length - 1] as { name: string }).name} depends on` : "a dependency is"} ${registered.name} from another copy of its @pso package (contract ${token.contract}) than the one this runtime loaded (contract ${registered.contract}). The two versions cannot share an instance: install one version of the @pso packages`, startupDiagnostics([{ code: "PSO_DI_INCOMPATIBLE", message: `${registered.name}: contract ${token.contract} requested, contract ${registered.contract} loaded` }]));
      if (!reported.has(token.id)) {
        reported.add(token.id);
        log("warn", `more than one copy of an @pso package is loaded: ${registered.name} was requested through another copy than the one the runtime uses. The runtime's instance is injected (same contract); instanceof checks and static state of the other copy do not apply. Install a single copy; on Windows also start the process with the path spelled the way the files are imported (drive letter case)`, { component: "di", code: "PSO_DUPLICATE_PACKAGE", dependency: registered.name, ...(chain.length ? { requestedBy: (chain[chain.length - 1] as { name: string }).name } : {}) });
      }
      instances.set(cls, registered.instance);
      return registered.instance;
    }
    if (chain.includes(cls)) throw new Error(`circular dependency on ${cls.name}`);
    const types = (Reflect.getMetadata("design:paramtypes", cls) as Array<new (...a: never[]) => unknown> | undefined) ?? [];
    const inst = new cls(...(types.map((t) => resolve_(t, [...chain, cls])) as never[]));
    instances.set(cls, inst);
    return inst;
  };
  return resolve_;
}
