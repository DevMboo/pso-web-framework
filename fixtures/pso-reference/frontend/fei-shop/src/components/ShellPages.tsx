import { FiAlertOctagon, FiCompass, FiLock, FiRefreshCw, FiWifiOff } from "react-icons/fi";
import { Link } from "react-router-dom";
import type { RemoteLoadError } from "@pso/frontend-react";

function Panel({ icon: Icon, title, children, tone = "text-muted" }: { icon: typeof FiLock; title: string; children?: React.ReactNode; tone?: string }) {
  return (
    <section role="alert" className="mx-auto mt-16 max-w-lg rounded-pso border border-line bg-surface p-8 text-center">
      <Icon className={`mx-auto h-10 w-10 ${tone}`} aria-hidden="true" />
      <h1 className="mt-4 text-xl font-semibold">{title}</h1>
      <div className="mt-2 text-sm text-muted">{children}</div>
    </section>
  );
}

const btn = "mt-6 inline-flex items-center gap-2 rounded-pso bg-brand px-4 py-2 text-sm font-medium text-brand-fg hover:opacity-90";

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-center gap-3 p-16 text-muted">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-brand" aria-hidden="true" />
      <span className="text-sm">{label}…</span>
    </div>
  );
}

export function Forbidden({ reason }: { reason: string }) {
  return (
    <Panel icon={FiLock} title="Access denied" tone="text-warn">
      <p>{reason}</p>
      <p className="mt-2">If you need this area, ask an administrator to grant it. Nothing was changed.</p>
      <Link to="/" className={btn}>Back to home</Link>
    </Panel>
  );
}

export function NotFound() {
  return (
    <Panel icon={FiCompass} title="Page not found">
      <p>There is nothing at this address.</p>
      <Link to="/" className={btn}>Back to home</Link>
    </Panel>
  );
}

const KIND: Record<string, string> = {
  "manifest-unavailable": "The release of this module could not be reached. It may be deploying, or the server is unavailable.",
  "load-failed": "The code of this module could not be loaded.",
  timeout: "The module took too long to load.",
  incompatible: "This module was built for a different version of the application and cannot run here.",
  signature: "The release of this module could not be verified, so it was not loaded.",
  untrusted: "The location of this module is not approved.",
  "manifest-invalid": "The release information of this module is invalid.",
  "bad-module": "This module is not a valid PSO microfrontend.",
  "not-registered": "This module is not registered in the application.",
};

export function RemoteUnavailable({ name, error, retry }: { name: string; error: RemoteLoadError | Error; retry(): void }) {
  const kind = (error as RemoteLoadError).kind;
  const reasons = (error as RemoteLoadError).reasons ?? [];
  return (
    <Panel icon={FiWifiOff} title={`${name.replace(/^mei-/, "")} is unavailable`} tone="text-warn">
      <p>{(kind && KIND[kind]) ?? "This module failed while running."} The rest of the application keeps working.</p>
      {reasons.length ? <ul className="mx-auto mt-2 max-w-md list-disc pl-5 text-left">{reasons.slice(0, 4).map((r) => <li key={r}>{r}</li>)}</ul> : null}
      <details className="mt-3 text-left"><summary className="cursor-pointer text-xs">Technical detail</summary><p className="mt-1 break-words font-mono text-xs">{error.message}</p></details>
      <button type="button" onClick={retry} className={btn}><FiRefreshCw aria-hidden="true" /> Try again</button>
    </Panel>
  );
}

export function Crash({ error, reset }: { error: Error; reset(): void }) {
  return (
    <Panel icon={FiAlertOctagon} title="Something went wrong" tone="text-bad">
      <p>The application hit an unexpected error. Your data was not changed by this screen.</p>
      <details className="mt-3 text-left"><summary className="cursor-pointer text-xs">Technical detail</summary><p className="mt-1 break-words font-mono text-xs">{error.message}</p></details>
      <button type="button" onClick={reset} className={btn}><FiRefreshCw aria-hidden="true" /> Reload this view</button>
    </Panel>
  );
}
