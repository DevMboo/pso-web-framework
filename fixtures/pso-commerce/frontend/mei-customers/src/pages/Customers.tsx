import { Link } from "react-router-dom";
import { FiPlus, FiRefreshCw } from "react-icons/fi";
import { PsoApiError, usePsoContext } from "@pso/frontend-react";
import { Badge, Empty, ErrorBox, LinkButton, Loading, PageHeader, btnGhost } from "../components/ui";
import { useCustomersService, useLoad } from "../hooks/useCustomers";

export default function Customers() {
  const { hasScope } = usePsoContext();
  const service = useCustomersService();
  const list = useLoad((s) => service.findAll(s), "all");
  // this orchestrator may not publish a listing (GET /customers): then the page says so instead of inventing data
  const noListing = list.status === "error" && list.error instanceof PsoApiError && (list.error.status === 404 || list.error.status === 405);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Customers" subtitle="People and companies that can place orders"
        actions={<>
          <button type="button" onClick={list.reload} className={btnGhost}><FiRefreshCw aria-hidden="true" /> Refresh</button>
          {hasScope("customers:write") ? <LinkButton to="/customers/new" primary><FiPlus aria-hidden="true" /> New customer</LinkButton> : null}
        </>} />
      {list.status === "loading" ? <Loading label="Loading customers" /> : null}
      {list.status === "error" && !noListing ? <ErrorBox error={list.error} onRetry={list.reload} /> : null}
      {noListing ? <Empty>This environment does not publish a customer listing. Open a customer by its identifier from the address <code>/customers/&lt;id&gt;</code>, or create one.</Empty> : null}
      {list.status === "ready" && list.data.length === 0 ? <Empty>No customers yet.</Empty> : null}
      {list.status === "ready" && list.data.length > 0 ? (
        <div className="mt-6 overflow-x-auto rounded-pso border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Customers</caption>
            <thead className="border-b border-line text-xs uppercase text-muted"><tr><th scope="col" className="px-4 py-2">Name</th><th scope="col" className="px-4 py-2">Email</th><th scope="col" className="px-4 py-2">Status</th></tr></thead>
            <tbody className="divide-y divide-line">
              {list.data.map((c) => (
                <tr key={c.id} className="hover:bg-surface-2">
                  <td className="px-4 py-2"><Link className="font-medium text-brand hover:underline" to={`/customers/${encodeURIComponent(c.id)}`}>{c.name}</Link></td>
                  <td className="px-4 py-2 text-muted">{c.email}</td>
                  <td className="px-4 py-2">{c.status !== undefined ? <Badge tone={c.status === "ACTIVE" ? "ok" : "warn"}>{c.status}</Badge> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
