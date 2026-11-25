import { Component, Suspense, lazy, useEffect, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { Navigate, Route, Routes, useInRouterContext } from "react-router-dom";
import type { MeiModuleExport, MiddlewareDefinition } from "@pso/frontend";
import { resolveText, usePsoContext } from "./context.tsx";

/** One node of the route table the framework generates from ROUTES.pso.ts. */
export interface MeiRouteNode {
  path: string;
  load?: () => Promise<{ default: ComponentType }>;
  layout?: () => Promise<{ default: ComponentType<{ children?: ReactNode }> }>;
  redirect?: string;
  title?: string | Record<string, string>;
  scopes?: string[];
  meta?: Record<string, unknown>;
  children?: MeiRouteNode[];
}

export interface MeiModule extends MeiModuleExport { readonly middlewares: ReadonlyArray<MiddlewareDefinition>; readonly routes: ReadonlyArray<MeiRouteNode> }

export interface CreateMeiModuleInput {
  name: string;
  contract: string;
  routes: MeiRouteNode[];
  middlewares?: MiddlewareDefinition[];
  /** replace the default not-found view of this MEI */
  NotFound?: ComponentType;
}

/** Boundary around a MEI: an exception inside it must not take the shell down. */
export class MeiBoundary extends Component<{ name: string; fallback: (error: Error, reset: () => void) => ReactNode; children?: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo): void { void info; void error; }
  override render(): ReactNode { return this.state.error ? this.props.fallback(this.state.error, () => this.setState({ error: null })) : this.props.children; }
}

function slash(p: string): string { return p.replace(/^\/+/, "") || "/"; }

function Guarded({ node, children }: { node: MeiRouteNode; children: ReactNode }) {
  const ctx = usePsoContext();
  const allowed = (node.scopes ?? []).every((s) => ctx.hasScope(s));
  const title = resolveText(node.title, ctx.locale);
  useEffect(() => { if (allowed && title) document.title = title; }, [allowed, title]);
  if (!allowed) return <div role="alert" className="pso-denied" data-pso="route-denied"><h2>Access denied</h2><p>Your session does not include the scopes this page needs ({(node.scopes ?? []).join(", ")}).</p></div>;
  return <>{children}</>;
}

function elementFor(node: MeiRouteNode, Fallback: ReactNode): ReactNode {
  if (node.redirect) return <Navigate to={node.redirect} replace />;
  if (!node.load) return undefined;
  const Page = lazy(node.load);
  const Layout = node.layout ? lazy(node.layout) : undefined;
  const body = <Guarded node={node}><Page /></Guarded>;
  return <Suspense fallback={Fallback}>{Layout ? <Layout>{body}</Layout> : body}</Suspense>;
}

export function renderRoutes(nodes: readonly MeiRouteNode[], Fallback: ReactNode, base = ""): ReactNode[] {
  return nodes.flatMap((n) => {
    const own = n.path === "/" ? "" : n.path;
    const full = `${base}${own}`;
    const el = elementFor(n, Fallback);
    const out: ReactNode[] = [];
    // each declared route becomes one flat <Route>: the framework resolves precedence (static > :param > *) in the matcher of React Router
    if (el !== undefined) out.push(<Route key={`${n.path}|${out.length}|${full}`} path={slash(full)} element={el} />);
    if (n.children) out.push(...renderRoutes(n.children, Fallback, full));
    return out;
  });
}

function DefaultNotFound() {
  return <div role="status" data-pso="mei-not-found"><h2>Page not found</h2><p>This microfrontend has no page at this address.</p></div>;
}

/**
 * The default export of `src/module.tsx`. It turns the generated route table into a React Router subtree, wraps it in an error
 * boundary and refuses to render outside a router: a MEI never creates its own history (that would fight the FEI over the URL).
 */
export function createMeiModule(input: CreateMeiModuleInput): MeiModule {
  const NotFound = input.NotFound ?? DefaultNotFound;
  const fallback = <div role="status" aria-live="polite" data-pso="mei-loading" className="pso-loading">Loading…</div>;
  // built ONCE: React.lazy components created during a render would be new components every time and remount the page
  const routeElements = renderRoutes(input.routes, fallback);
  function Root() {
    if (!useInRouterContext()) throw new Error(`${input.name}: rendered outside a router. A MEI is mounted by its FEI (or by the standalone development host); it must not create BrowserRouter, HashRouter or MemoryRouter itself.`);
    return (
      <div data-pso-mei={input.name} className="pso-mei">
        <Routes>
          {routeElements}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
    );
  }
  return Object.freeze({ kind: "pso-mei-module" as const, name: input.name, contract: input.contract, Root, middlewares: Object.freeze([...(input.middlewares ?? [])]), routes: Object.freeze([...input.routes]) });
}
