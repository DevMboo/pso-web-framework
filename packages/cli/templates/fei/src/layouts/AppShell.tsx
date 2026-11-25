import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { FiHome, FiLogOut, FiMenu, FiMoon, FiSun, FiX } from "react-icons/fi";
import { useBreadcrumbs, useConnectionState, useFei, useNavItems, usePrefetch, useSession, useTheme, useAuth } from "@pso/frontend-react";
import { iconFor } from "../shared/icons";
import { Notifications } from "../components/Notifications";

const link = "flex items-center gap-3 rounded-pso px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg";
const linkActive = "bg-surface-2 text-fg";

function ConnectionBadge() {
  const state = useConnectionState();
  const tone = state === "connected" ? "bg-ok" : state === "idle" || state === "closed" ? "bg-line" : "bg-warn";
  return <span className="hidden items-center gap-2 text-xs text-muted sm:flex" title={`Real-time channel: ${state}`}><span className={`h-2 w-2 rounded-full ${tone}`} aria-hidden="true" /><span>{state === "connected" ? "Live" : state === "idle" ? "Idle" : state}</span></span>;
}

/** The global layout. Public pages (sign-in) render without chrome. */
export function AppShell({ children }: { children?: ReactNode }) {
  const session = useSession();
  const fei = useFei();
  const items = useNavItems();
  const prefetch = usePrefetch();
  const crumbs = useBreadcrumbs();
  const { theme, setTheme } = useTheme();
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useEffect(() => { document.title = crumbs.length ? `${crumbs[crumbs.length - 1]!.title} · ${fei.name}` : fei.name; }, [crumbs, fei.name]);

  // a shell without sign-in (FEI.pso.ts, or `pso frontend:config --env <name> --auth none`) shows its full layout to every visitor
  const anonymous = fei.authentication === "none";
  if (!anonymous && session.status !== "signed-in" && fei.name) {
    return <div className="min-h-screen bg-bg text-fg">{fei.devTokenBuild ? <DevTokenBanner /> : null}<main id="main">{children}</main><Notifications /></div>;
  }
  return (
    <div className="min-h-screen bg-bg text-fg">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-brand focus:px-3 focus:py-2 focus:text-brand-fg">Skip to content</a>
      {fei.devTokenBuild ? <DevTokenBanner /> : null}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface px-4">
        <button type="button" className="rounded p-2 text-muted hover:bg-surface-2 md:hidden" onClick={() => setOpen((o) => !o)} aria-label={open ? "Close navigation" : "Open navigation"} aria-expanded={open} aria-controls="sidebar">{open ? <FiX aria-hidden="true" /> : <FiMenu aria-hidden="true" />}</button>
        <Link to="/" className="flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-md bg-brand text-brand-fg" aria-hidden="true">P</span><span>{fei.name.replace(/^fei-/, "")}</span></Link>
        <nav aria-label="Breadcrumb" className="ml-4 hidden min-w-0 flex-1 md:block">
          <ol className="flex items-center gap-2 text-sm text-muted">{crumbs.map((c, i) => <li key={c.path} className="flex min-w-0 items-center gap-2">{i > 0 ? <span aria-hidden="true">/</span> : null}{i === crumbs.length - 1 ? <span aria-current="page" className="truncate font-medium text-fg">{c.title}</span> : <Link className="truncate hover:text-fg" to={c.path}>{c.title}</Link>}</li>)}</ol>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <ConnectionBadge />
          <button type="button" className="rounded p-2 text-muted hover:bg-surface-2" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>{theme === "dark" ? <FiSun aria-hidden="true" /> : <FiMoon aria-hidden="true" />}</button>
          {anonymous ? null : <span className="hidden max-w-40 truncate text-sm text-muted sm:block" title={session.user?.id}>{session.user?.name ?? session.user?.id}</span>}
          {anonymous ? null : <button type="button" className="flex items-center gap-2 rounded-pso border border-line px-3 py-1.5 text-sm hover:bg-surface-2" onClick={() => { void signOut(); }}><FiLogOut aria-hidden="true" /><span className="hidden sm:inline">Sign out</span></button>}
        </div>
      </header>
      <div className="md:grid md:grid-cols-[14rem_1fr]">
        <aside id="sidebar" className={`${open ? "block" : "hidden"} border-b border-line bg-surface p-3 md:block md:min-h-[calc(100vh-3.5rem)] md:border-b-0 md:border-r`}>
          <nav aria-label="Main">
            <ul className="space-y-1">
              <li><NavLink to="/" end className={({ isActive }) => `${link} ${isActive ? linkActive : ""}`}><FiHome aria-hidden="true" />Home</NavLink></li>
              {items.map((it) => { const Icon = iconFor(it.icon); return (
                <li key={it.name}>
                  <NavLink to={it.path} className={({ isActive }) => `${link} ${isActive ? linkActive : ""}`} onMouseEnter={() => prefetch(it.name)} onFocus={() => prefetch(it.name)}>
                    <Icon aria-hidden="true" /><span className="flex-1">{it.title}</span>
                    {it.status === "loading" ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-brand" role="status" aria-label="loading" /> : null}
                  </NavLink>
                </li>
              ); })}
            </ul>
          </nav>
        </aside>
        <main id="main" className="min-w-0 p-4 md:p-6" tabIndex={-1}>{children}</main>
      </div>
      <Notifications />
    </div>
  );
}

function DevTokenBanner() {
  return <div role="note" className="bg-warn px-4 py-1.5 text-center text-xs font-medium text-white">Validation build: sign-in with a pasted development token is enabled. This is not a production configuration.</div>;
}
