import { useParams } from "react-router-dom";
import { FiRadio, FiRefreshCw } from "react-icons/fi";
import { usePsoContext } from "@pso/frontend-react";
import { Badge, ErrorBox, Loading, PageHeader, btnGhost } from "../components/ui";
import { useLiveOrder } from "../hooks/useOrders";
import { money, statusTone } from "../models/order.ts";

export default function OrderDetails() {
  const { id = "" } = useParams();
  const { locale, navigate, hasScope } = usePsoContext();
  const { order, mode, reload, channelState, lastEventAt } = useLiveOrder(id);
  if (order.status === "loading") return <Loading label="Loading order" />;
  if (order.status === "error") return <div className="mx-auto max-w-3xl"><ErrorBox error={order.error} onRetry={reload} /></div>;
  const o = order.data;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Order" subtitle={<span className="font-mono">{o.id}</span>}
        actions={<button type="button" className={btnGhost} onClick={reload}><FiRefreshCw aria-hidden="true" /> Refresh</button>} />
      <div className="mt-6 flex flex-wrap items-center gap-3 rounded-pso border border-line bg-surface p-5">
        <span className="text-xs uppercase text-muted">Status</span>
        <span aria-live="polite" data-testid="order-status"><Badge tone={statusTone(o.status)}>{o.status}</Badge></span>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted" data-testid="live-mode">
          <FiRadio aria-hidden="true" className={mode === "channel" ? "text-ok" : "text-muted"} />
          {mode === "done" ? "Decided: no further updates" : mode === "channel" ? "Live: waiting for the order.updated event" : `Checking periodically (channel ${channelState})`}
          {lastEventAt ? <span>· event received</span> : null}
        </span>
      </div>
      <dl className="mt-4 grid gap-4 rounded-pso border border-line bg-surface p-5 sm:grid-cols-2">
        <div><dt className="text-xs uppercase text-muted">Customer</dt><dd className="mt-1 break-all font-mono text-xs">{hasScope("customers:read") ? <button type="button" className="text-brand hover:underline" onClick={() => navigate(`/customers/${encodeURIComponent(o.customerId)}`)}>{o.customerId}</button> : o.customerId}</dd></div>
        <div><dt className="text-xs uppercase text-muted">Product</dt><dd className="mt-1 break-all font-mono text-xs">{hasScope("catalog:read") ? <button type="button" className="text-brand hover:underline" onClick={() => navigate(`/catalog/${encodeURIComponent(o.productId)}`)}>{o.productId}</button> : o.productId}</dd></div>
        <div><dt className="text-xs uppercase text-muted">Quantity</dt><dd className="mt-1 text-sm tabular-nums">{o.quantity}</dd></div>
        <div><dt className="text-xs uppercase text-muted">Unit price</dt><dd className="mt-1 text-sm tabular-nums">{money(o.unitPriceCents, locale)}</dd></div>
        <div className="sm:col-span-2"><dt className="text-xs uppercase text-muted">Total</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{money(o.totalCents, locale)}</dd></div>
      </dl>
    </div>
  );
}
