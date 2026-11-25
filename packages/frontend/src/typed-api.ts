import type { PsoApi, PsoRequestOptions } from "./contracts.ts";

/**
 * Typed calls over the orchestrator contract that `pso frontend:contracts` generates. The generated file owns the types (operation ids,
 * request bodies, declared success responses); this function owns the mechanics: path parameters are substituted and encoded, the method
 * is dispatched to the same `api` the host gave the microfrontend (so authentication, correlation, cancellation and error classification
 * are unchanged), and nothing leaves the orchestrator's relative paths.
 */
export interface OperationEntry { readonly method: string; readonly path: string; readonly pathParams: readonly string[] }
export type OperationTable = { readonly [id: string]: OperationEntry };

export type TypedCallOptions<Body> = Omit<PsoRequestOptions, "query"> & {
  /** values for the `:name` segments of the path; they are URL-encoded */
  params?: Readonly<Record<string, string | number>>;
  query?: PsoRequestOptions["query"];
} & ([Body] extends [never] ? { body?: undefined } : { body: Body });

export type TypedOperations<Ops extends OperationTable, Bodies, Success> = {
  call<Id extends keyof Ops & string>(id: Id, ...args: Id extends keyof Bodies ? [options: TypedCallOptions<Bodies[Id]>] : [options?: TypedCallOptions<never>]): Promise<Id extends keyof Success ? Success[Id] : unknown>;
};

export function typedOperations<Ops extends OperationTable, Bodies = Record<string, never>, Success = Record<string, unknown>>(api: PsoApi, table: Ops): TypedOperations<Ops, Bodies, Success> {
  return {
    call(id: string, ...args: unknown[]): Promise<never> {
      const op = table[id];
      if (!op) return Promise.reject(new Error(`unknown operation "${id}": it is not part of the orchestrator contract (run pso frontend:contracts)`));
      const o = (args[0] ?? {}) as TypedCallOptions<unknown> & { body?: unknown };
      let path = op.path;
      for (const name of op.pathParams) {
        const v = o.params?.[name];
        if (v === undefined || v === null || String(v) === "") return Promise.reject(new Error(`operation "${id}" needs the path parameter "${name}"`));
        path = path.replace(`:${name}`, encodeURIComponent(String(v)));
      }
      const { params: _p, body, ...rest } = o as Record<string, unknown> & { params?: unknown; body?: unknown };
      void _p;
      const opts = rest as PsoRequestOptions;
      const m = op.method.toUpperCase();
      switch (m) {
        case "GET": return api.get(path, opts) as Promise<never>;
        case "DELETE": return api.delete(path, opts) as Promise<never>;
        case "POST": return api.post(path, body, opts) as Promise<never>;
        case "PUT": return api.put(path, body, opts) as Promise<never>;
        case "PATCH": return api.patch(path, body, opts) as Promise<never>;
        default: return Promise.reject(new Error(`operation "${id}" uses ${m}, which the frontend client does not send`));
      }
    },
  } as TypedOperations<Ops, Bodies, Success>;
}
