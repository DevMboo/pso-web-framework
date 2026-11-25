import { useState } from "react";
import { useParams } from "react-router-dom";
import { FiShoppingCart, FiUserCheck, FiUserX } from "react-icons/fi";
import { usePsoContext } from "@pso/frontend-react";
import { Badge, ErrorBox, Loading, PageHeader, btnGhost, btnPrimary, describe } from "../components/ui";
import { useCustomersService, useLoad } from "../hooks/useCustomers";
import type { CustomerStatus } from "../models/customer.ts";

export default function CustomerDetails() {
  const { id = "" } = useParams();
  const { hasScope, navigate, notifications } = usePsoContext();
  const service = useCustomersService();
  const customer = useLoad((s) => service.findById(id, s), id);
  const [busy, setBusy] = useState(false);

  async function setStatus(status: CustomerStatus) {
    setBusy(true);
    try { await service.setStatus(id, status); notifications.notify(`Customer ${status === "ACTIVE" ? "activated" : "suspended"}`, { level: "success" }); customer.reload(); }
    catch (e) { const d = describe(e as Error); notifications.notify(`${d.title}. ${d.detail}`, { level: "error", title: "Status not changed" }); }
    finally { setBusy(false); }
  }

  if (customer.status === "loading") return <Loading label="Loading customer" />;
  if (customer.status === "error") return <div className="mx-auto max-w-3xl"><ErrorBox error={customer.error} onRetry={customer.reload} /></div>;
  const c = customer.data;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={c.name} subtitle={<span className="font-mono">{c.id}</span>}
        actions={<>
          {hasScope("orders:write") ? <button type="button" className={btnPrimary} onClick={() => navigate(`/orders/new?customerId=${encodeURIComponent(c.id)}`)}><FiShoppingCart aria-hidden="true" /> Place an order</button> : null}
          {hasScope("customers:write") && c.status !== undefined ? (c.status === "ACTIVE"
            ? <button type="button" className={btnGhost} disabled={busy} onClick={() => { void setStatus("SUSPENDED"); }}><FiUserX aria-hidden="true" /> Suspend</button>
            : <button type="button" className={btnGhost} disabled={busy} onClick={() => { void setStatus("ACTIVE"); }}><FiUserCheck aria-hidden="true" /> Activate</button>) : null}
        </>} />
      <dl className="mt-6 grid gap-4 rounded-pso border border-line bg-surface p-5 sm:grid-cols-2">
        <div><dt className="text-xs uppercase text-muted">Email</dt><dd className="mt-1 text-sm">{c.email}</dd></div>
        {c.status !== undefined ? <div><dt className="text-xs uppercase text-muted">Status</dt><dd className="mt-1"><Badge tone={c.status === "ACTIVE" ? "ok" : "warn"}>{c.status}</Badge></dd></div> : null}
      </dl>
    </div>
  );
}
