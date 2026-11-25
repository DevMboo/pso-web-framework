import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { FiShoppingCart } from "react-icons/fi";
import { usePsoContext } from "@pso/frontend-react";
import { Badge, ErrorBox, Field, Loading, PageHeader, btnGhost, btnPrimary, describe, input } from "../components/ui";
import { useLoad, useProductsService } from "../hooks/useProducts";
import { formatPrice, isAvailable } from "../models/product.ts";

export default function ProductDetails() {
  const { id = "" } = useParams();
  const { hasScope, navigate, notifications, locale } = usePsoContext();
  const service = useProductsService();
  const product = useLoad((s) => service.findById(id, s), id);
  const [stock, setStock] = useState("");
  const [busy, setBusy] = useState(false);

  async function adjust(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{1,6}$/.test(stock)) return;
    setBusy(true);
    try { await service.setStock(id, Number(stock)); notifications.notify("Stock updated", { level: "success" }); setStock(""); product.reload(); }
    catch (err) { const d = describe(err as Error); notifications.notify(`${d.title}. ${d.detail}`, { level: "error", title: "Stock not changed" }); }
    finally { setBusy(false); }
  }

  if (product.status === "loading") return <Loading label="Loading product" />;
  if (product.status === "error") return <div className="mx-auto max-w-3xl"><ErrorBox error={product.error} onRetry={product.reload} /></div>;
  const p = product.data;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={p.name} subtitle={<span className="font-mono">{p.sku}</span>}
        actions={<>
          <button type="button" className={btnGhost} onClick={product.reload}>Refresh stock</button>
          {hasScope("orders:write") && isAvailable(p) ? <button type="button" className={btnPrimary} onClick={() => navigate(`/orders/new?productId=${encodeURIComponent(p.id)}`)}><FiShoppingCart aria-hidden="true" /> Order this product</button> : null}
        </>} />
      <dl className="mt-6 grid gap-4 rounded-pso border border-line bg-surface p-5 sm:grid-cols-3">
        <div><dt className="text-xs uppercase text-muted">Price</dt><dd className="mt-1 text-sm tabular-nums">{formatPrice(p.priceCents, locale)}</dd></div>
        <div><dt className="text-xs uppercase text-muted">Stock</dt><dd className="mt-1 text-sm tabular-nums" data-testid="stock">{p.stock}</dd></div>
        <div><dt className="text-xs uppercase text-muted">Availability</dt><dd className="mt-1"><Badge tone={isAvailable(p) ? "ok" : "bad"}>{isAvailable(p) ? "In stock" : "Out of stock"}</Badge></dd></div>
      </dl>
      {hasScope("catalog:write") ? (
        <form onSubmit={(e) => { void adjust(e); }} className="mt-6 flex flex-wrap items-end gap-3 rounded-pso border border-line bg-surface p-5">
          <Field id="stock" label="Set stock to"><input id="stock" inputMode="numeric" className={`${input} w-32`} value={stock} onChange={(e) => setStock(e.target.value)} autoComplete="off" /></Field>
          <button type="submit" className={btnGhost} disabled={busy || !/^\d{1,6}$/.test(stock)}>{busy ? "Saving…" : "Update stock"}</button>
        </form>
      ) : null}
    </div>
  );
}
