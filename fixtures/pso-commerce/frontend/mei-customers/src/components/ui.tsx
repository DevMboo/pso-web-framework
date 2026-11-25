import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { FiAlertCircle, FiInbox, FiLoader } from "react-icons/fi";
import { PsoApiError } from "@pso/frontend-react";

/** Small presentational pieces of this microfrontend. Each MEI owns its copy: independent teams do not share a component library. */

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-semibold">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}

export const btn = "inline-flex items-center gap-2 rounded-pso px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
export const btnPrimary = `${btn} bg-brand text-brand-fg hover:opacity-90`;
export const btnGhost = `${btn} border border-line bg-surface text-fg hover:bg-surface-2`;

export function LinkButton({ to, children, primary }: { to: string; children: ReactNode; primary?: boolean }) {
  return <Link to={to} className={primary ? btnPrimary : btnGhost}>{children}</Link>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return <p role="status" className="mt-6 flex items-center gap-2 text-sm text-muted"><FiLoader className="animate-spin" aria-hidden="true" />{label}…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-col items-center gap-2 rounded-pso border border-dashed border-line p-10 text-center text-sm text-muted"><FiInbox className="h-6 w-6" aria-hidden="true" />{children}</div>;
}

/** What the person should read when a call to the orchestrator failed. Never shows more than the Problem Details the orchestrator chose to send. */
export function describe(error: Error): { title: string; detail: string; reference?: string } {
  if (error instanceof PsoApiError) {
    const reference = error.correlationId;
    const base = { detail: error.problem?.detail ?? error.message, ...(reference ? { reference } : {}) };
    if (error.kind === "network") return { title: "The service could not be reached", detail: "Check your connection and try again.", ...(reference ? { reference } : {}) };
    if (error.kind === "timeout") return { title: "The service took too long to answer", detail: "Try again in a moment.", ...(reference ? { reference } : {}) };
    if (error.status === 401) return { title: "Your session is no longer valid", detail: "Sign in again to continue.", ...(reference ? { reference } : {}) };
    if (error.status === 403) return { title: "You are not allowed to do this", detail: "Your account lacks a required permission.", ...(reference ? { reference } : {}) };
    if (error.status === 404) return { title: "Not found", ...base };
    if (error.status === 409) return { title: "This conflicts with the current state", ...base };
    return { title: error.problem?.title ?? "The request failed", ...base };
  }
  return { title: "Something went wrong", detail: error.message };
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const d = describe(error);
  return (
    <div role="alert" className="mt-6 flex gap-3 rounded-pso border border-line bg-surface p-4 text-sm">
      <FiAlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-bad" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium">{d.title}</p>
        <p className="mt-1 break-words text-muted">{d.detail}{d.reference ? ` (reference ${d.reference})` : ""}</p>
        {onRetry ? <button type="button" onClick={onRetry} className={`${btnGhost} mt-3`}>Try again</button> : null}
      </div>
    </div>
  );
}

export function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string[] | undefined; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      <div className="mt-1">{children}</div>
      {hint ? <p id={`${id}-hint`} className="mt-1 text-xs text-muted">{hint}</p> : null}
      {error?.length ? <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-bad">{error.join(" ")}</p> : null}
    </div>
  );
}
export const input = "block w-full rounded-pso border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted";

export function Badge({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: ReactNode }) {
  const cls = { ok: "text-ok", warn: "text-warn", bad: "text-bad", muted: "text-muted" }[tone];
  return <span className={`inline-flex items-center rounded-full border border-line px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}
