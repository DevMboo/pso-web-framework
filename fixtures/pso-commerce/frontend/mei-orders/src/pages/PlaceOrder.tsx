import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { PsoApiError, usePsoContext } from "@pso/frontend-react";
import { Field, PageHeader, btnGhost, btnPrimary, describe, input } from "../components/ui";
import { useOrdersService } from "../hooks/useOrders";

export default function PlaceOrder() {
  const { navigate, notifications } = usePsoContext();
  const service = useOrdersService();
  const [params] = useSearchParams();
  // the customer and product pages of the other microfrontends link here with ?customerId= / ?productId=
  const [customerId, setCustomerId] = useState(params.get("customerId") ?? "");
  const [productId, setProductId] = useState(params.get("productId") ?? "");
  const [quantity, setQuantity] = useState("1");
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const qty = /^\d{1,4}$/.test(quantity) ? Number(quantity) : undefined;
  const valid = customerId.trim() !== "" && productId.trim() !== "" && qty !== undefined && qty >= 1 && qty <= 1000;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || qty === undefined || busy) return; // the button is disabled while the request is in flight: a double click cannot place two orders
    setBusy(true); setFields({}); setFailure(null);
    try {
      const order = await service.place({ customerId: customerId.trim(), productId: productId.trim(), quantity: qty });
      notifications.notify(`Order placed (${order.status.toLowerCase()}). Its status updates on the next screen.`, { level: "success" });
      navigate(`/orders/${encodeURIComponent(order.id)}`);
    } catch (err) {
      if (err instanceof PsoApiError && Object.keys(err.fieldErrors).length) setFields(err.fieldErrors);
      const d = describe(err as Error);
      setFailure(`${d.title}. ${d.detail}${d.reference ? ` (reference ${d.reference})` : ""}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Place an order" />
      <form onSubmit={(e) => { void submit(e); }} className="mt-6 space-y-4 rounded-pso border border-line bg-surface p-5" noValidate>
        <Field id="customerId" label="Customer identifier" error={fields["customerId"]} hint="Open a customer in Customers and use “Place an order” to fill this in"><input id="customerId" className={`${input} font-mono`} value={customerId} onChange={(e) => setCustomerId(e.target.value)} required autoComplete="off" /></Field>
        <Field id="productId" label="Product identifier" error={fields["productId"]} hint="Open a product in Catalog and use “Order this product”"><input id="productId" className={`${input} font-mono`} value={productId} onChange={(e) => setProductId(e.target.value)} required autoComplete="off" /></Field>
        <Field id="quantity" label="Quantity" error={fields["quantity"] ?? (qty === undefined || qty < 1 || qty > 1000 ? ["Between 1 and 1000"] : undefined)}><input id="quantity" inputMode="numeric" className={`${input} w-28`} value={quantity} onChange={(e) => setQuantity(e.target.value)} required autoComplete="off" /></Field>
        {failure ? <p role="alert" className="text-sm text-bad">{failure}</p> : null}
        <div className="flex gap-2">
          <button type="submit" className={btnPrimary} disabled={busy || !valid}>{busy ? "Placing…" : "Place order"}</button>
          <button type="button" className={btnGhost} onClick={() => navigate("/orders")}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
