import { useState, type FormEvent } from "react";
import { PsoApiError, usePsoContext } from "@pso/frontend-react";
import { Field, PageHeader, btnGhost, btnPrimary, describe, input } from "../components/ui";
import { useProductsService } from "../hooks/useProducts";
import { parsePrice } from "../models/product.ts";

export default function CreateProduct() {
  const { navigate, notifications } = usePsoContext();
  const service = useProductsService();
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [stock, setStock] = useState("0");
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const cents = parsePrice(price);
  const stockN = /^\d{1,6}$/.test(stock) ? Number(stock) : undefined;
  const valid = sku.trim().length >= 2 && name.trim().length >= 2 && cents !== undefined && stockN !== undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || cents === undefined || stockN === undefined) return;
    setBusy(true); setFields({}); setFailure(null);
    try {
      const created = await service.create({ sku: sku.trim(), name: name.trim(), priceCents: cents, stock: stockN });
      notifications.notify(`Product ${created.name} created`, { level: "success" });
      navigate(`/catalog/${encodeURIComponent(created.id)}`);
    } catch (err) {
      if (err instanceof PsoApiError && Object.keys(err.fieldErrors).length) setFields(err.fieldErrors);
      const d = describe(err as Error);
      setFailure(`${d.title}. ${d.detail}${d.reference ? ` (reference ${d.reference})` : ""}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="New product" />
      <form onSubmit={(e) => { void submit(e); }} className="mt-6 space-y-4 rounded-pso border border-line bg-surface p-5" noValidate>
        <Field id="sku" label="SKU" error={fields["sku"]} hint="2 to 40 characters, unique in the catalog"><input id="sku" className={input} value={sku} onChange={(e) => setSku(e.target.value)} required maxLength={40} autoComplete="off" /></Field>
        <Field id="name" label="Name" error={fields["name"]}><input id="name" className={input} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="off" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="price" label="Price" error={fields["priceCents"] ?? (price && cents === undefined ? ["Use an amount like 19.90"] : undefined)}><input id="price" inputMode="decimal" className={input} value={price} onChange={(e) => setPrice(e.target.value)} required placeholder="19.90" autoComplete="off" /></Field>
          <Field id="stock" label="Initial stock" error={fields["stock"] ?? (stockN === undefined ? ["Use a whole number"] : undefined)}><input id="stock" inputMode="numeric" className={input} value={stock} onChange={(e) => setStock(e.target.value)} required autoComplete="off" /></Field>
        </div>
        {failure ? <p role="alert" className="text-sm text-bad">{failure}</p> : null}
        <div className="flex gap-2">
          <button type="submit" className={btnPrimary} disabled={busy || !valid}>{busy ? "Creating…" : "Create product"}</button>
          <button type="button" className={btnGhost} onClick={() => navigate("/catalog")}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
