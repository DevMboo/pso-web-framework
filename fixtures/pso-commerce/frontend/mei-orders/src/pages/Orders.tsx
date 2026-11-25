import { Link } from "react-router-dom";
import { FiPlus, FiRefreshCw } from "react-icons/fi";
import { PsoApiError, usePsoContext } from "@pso/frontend-react";
import { Badge, Empty, ErrorBox, LinkButton, Loading, PageHeader, btnGhost } from "../components/ui";
import { useLoad, useOrdersService } from "../hooks/useOrders";
import { money, statusTone } from "../models/order.ts";

export default function Orders() {
  const { hasScope, locale } = usePsoContext();
  const service = useOrdersService();
  const list = useLoad((s) => service.findAll(s), "all");
  const noListing = list.status === "error" && list.error instanceof PsoApiError && (list.error.status === 404 || list.error.status === 405);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Orders" subtitle="Orders are confirmed or rejected shortly after they are placed"
        actions={<>
          <button type="button" onClick={list.reload} className={btnGhost}><FiRefreshCw aria-hidden="true" /> Refresh</button>
          {hasScope("orders:write") ? <LinkButton to="/orders/new" primary><FiPlus aria-hidden="true" /> Place an order</LinkButton> : null}
        </>} />
      {list.status === "loading" ? <Loading label="Loading orders" /> : null}
      {list.status === "error" && !noListing ? <ErrorBox error={list.error} onRetry={list.reload} /> : null}
      {noListing ? <Empty>This environment does not publish an order listing. Look an order up by its identifier from <code>/orders/&lt;id&gt;</code>, or place one.</Empty> : null}
      {list.status === "ready" && list.data.length === 0 ? <Empty>No orders yet.</Empty> : null}
      {list.status === "ready" && list.data.length > 0 ? (
        <div className="mt-6 overflow-x-auto rounded-pso border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Orders</caption>
            <thead className="border-b border-line text-xs uppercase text-muted"><tr><th scope="col" className="px-4 py-2">Order</th><th scope="col" className="px-4 py-2 text-right">Qty</th><th scope="col" className="px-4 py-2 text-right">Total</th><th scope="col" className="px-4 py-2">Status</th></tr></thead>
            <tbody className="divide-y divide-line">
              {list.data.map((o) => (
                <tr key={o.id} className="hover:bg-surface-2">
                  <td className="px-4 py-2"><Link className="font-mono text-xs font-medium text-brand hover:underline" to={`/orders/${encodeURIComponent(o.id)}`}>{o.id}</Link></td>
                  <td className="px-4 py-2 text-right tabular-nums">{o.quantity}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(o.totalCents, locale)}</td>
                  <td className="px-4 py-2"><Badge tone={statusTone(o.status)}>{o.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
