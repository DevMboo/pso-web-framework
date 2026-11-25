import { Link } from "react-router-dom";
import { FiPlus, FiRefreshCw } from "react-icons/fi";
import { PsoApiError, usePsoContext } from "@pso/frontend-react";
import { Badge, Empty, ErrorBox, LinkButton, Loading, PageHeader, btnGhost } from "../components/ui";
import { useLoad, useProductsService } from "../hooks/useProducts";
import { formatPrice, isAvailable } from "../models/product.ts";

export default function Products() {
  const { hasScope, locale } = usePsoContext();
  const service = useProductsService();
  const list = useLoad((s) => service.findAll(s), "all");
  const noListing = list.status === "error" && list.error instanceof PsoApiError && (list.error.status === 404 || list.error.status === 405);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Catalog" subtitle="Products and their availability"
        actions={<>
          <button type="button" onClick={list.reload} className={btnGhost}><FiRefreshCw aria-hidden="true" /> Refresh</button>
          {hasScope("catalog:write") ? <LinkButton to="/catalog/new" primary><FiPlus aria-hidden="true" /> New product</LinkButton> : null}
        </>} />
      {list.status === "loading" ? <Loading label="Loading products" /> : null}
      {list.status === "error" && !noListing ? <ErrorBox error={list.error} onRetry={list.reload} /> : null}
      {noListing ? <Empty>This environment does not publish a product listing. Open a product by its identifier from <code>/catalog/&lt;id&gt;</code>, or create one.</Empty> : null}
      {list.status === "ready" && list.data.length === 0 ? <Empty>No products yet.</Empty> : null}
      {list.status === "ready" && list.data.length > 0 ? (
        <div className="mt-6 overflow-x-auto rounded-pso border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Products</caption>
            <thead className="border-b border-line text-xs uppercase text-muted"><tr><th scope="col" className="px-4 py-2">Product</th><th scope="col" className="px-4 py-2">SKU</th><th scope="col" className="px-4 py-2 text-right">Price</th><th scope="col" className="px-4 py-2 text-right">Stock</th><th scope="col" className="px-4 py-2">Availability</th></tr></thead>
            <tbody className="divide-y divide-line">
              {list.data.map((p) => (
                <tr key={p.id} className="hover:bg-surface-2">
                  <td className="px-4 py-2"><Link className="font-medium text-brand hover:underline" to={`/catalog/${encodeURIComponent(p.id)}`}>{p.name}</Link></td>
                  <td className="px-4 py-2 font-mono text-xs text-muted">{p.sku}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatPrice(p.priceCents, locale)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{p.stock}</td>
                  <td className="px-4 py-2"><Badge tone={isAvailable(p) ? "ok" : "bad"}>{isAvailable(p) ? "In stock" : "Out of stock"}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
