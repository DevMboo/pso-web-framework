import { FiAlertCircle, FiRefreshCw } from "react-icons/fi";
import { PsoApiError, usePsoContext } from "@pso/frontend-react";
import { useUsers } from "../hooks/useUsers";

export default function Home() {
  const { user, permissions, tenant } = usePsoContext();
  const list = useUsers();
  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Users</h1>
        <button type="button" onClick={list.reload} className="inline-flex items-center gap-2 rounded-pso border border-line px-3 py-1.5 text-sm hover:bg-surface-2"><FiRefreshCw aria-hidden="true" /> Refresh</button>
      </div>
      <p className="mt-1 text-sm text-muted">Signed in as <span className="font-mono">{user?.id}</span>{tenant ? <> · tenant <span className="font-mono">{tenant.id}</span></> : null} · {permissions.length} scope(s)</p>

      {list.status === "loading" ? <p role="status" className="mt-6 text-sm text-muted">Loading…</p> : null}
      {list.status === "error" ? (
        <div role="alert" className="mt-6 flex gap-3 rounded-pso border border-line bg-surface p-4 text-sm">
          <FiAlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-bad" aria-hidden="true" />
          <div>
            <p className="font-medium">{list.error instanceof PsoApiError && list.error.status === 403 ? "You are not allowed to see this." : "The users could not be loaded."}</p>
            <p className="mt-1 text-muted">{list.error.message}{list.error instanceof PsoApiError && list.error.correlationId ? ` (reference ${list.error.correlationId})` : ""}</p>
          </div>
        </div>
      ) : null}
      {list.status === "ready" && list.data.length === 0 ? <p className="mt-6 rounded-pso border border-dashed border-line p-6 text-sm text-muted">Nothing here yet.</p> : null}
      {list.status === "ready" && list.data.length > 0 ? (
        <ul className="mt-6 divide-y divide-line rounded-pso border border-line bg-surface">
          {list.data.map((it) => <li key={it.id} className="px-4 py-3 text-sm">{it.name}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
