import { useState, type FormEvent } from "react";
import { PsoApiError, usePsoContext } from "@pso/frontend-react";
import { Field, PageHeader, btnGhost, btnPrimary, describe, input } from "../components/ui";
import { useCustomersService } from "../hooks/useCustomers";

export default function CreateCustomer() {
  const { navigate, notifications } = usePsoContext();
  const service = useCustomersService();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setFields({}); setFailure(null);
    try {
      const created = await service.create({ name: name.trim(), email: email.trim() });
      notifications.notify(`Customer ${created.name} created`, { level: "success" });
      navigate(`/customers/${encodeURIComponent(created.id)}`);
    } catch (err) {
      if (err instanceof PsoApiError && Object.keys(err.fieldErrors).length) setFields(err.fieldErrors);
      const d = describe(err as Error);
      setFailure(`${d.title}. ${d.detail}${d.reference ? ` (reference ${d.reference})` : ""}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="New customer" />
      <form onSubmit={(e) => { void submit(e); }} className="mt-6 space-y-4 rounded-pso border border-line bg-surface p-5" noValidate>
        <Field id="name" label="Name" error={fields["name"]}><input id="name" className={input} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} autoComplete="off" aria-invalid={!!fields["name"]} aria-describedby={fields["name"] ? "name-error" : undefined} /></Field>
        <Field id="email" label="Email" error={fields["email"]}><input id="email" type="email" className={input} value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" aria-invalid={!!fields["email"]} aria-describedby={fields["email"] ? "email-error" : undefined} /></Field>
        {failure ? <p role="alert" className="text-sm text-bad">{failure}</p> : null}
        <div className="flex gap-2">
          <button type="submit" className={btnPrimary} disabled={busy || name.trim().length < 2 || !email.trim()}>{busy ? "Creating…" : "Create customer"}</button>
          <button type="button" className={btnGhost} onClick={() => navigate("/customers")}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
