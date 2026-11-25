import { Link } from "react-router-dom";
import { FiArrowRight } from "react-icons/fi";
import { useNavItems, useSession } from "@pso/frontend-react";
import { iconFor } from "../shared/icons";

export default function Home() {
  const items = useNavItems();
  const session = useSession();
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold">Welcome{session.user?.name ? `, ${session.user.name}` : ""}</h1>
      <p className="mt-1 text-sm text-muted">Signed in as <span className="font-mono">{session.user?.id}</span>{session.tenant ? <> · tenant <span className="font-mono">{session.tenant.id}</span></> : null}</p>
      {items.length === 0 ? (
        <p className="mt-8 rounded-pso border border-dashed border-line p-6 text-sm text-muted">No microfrontend is available to your session yet. Register one with <code>pso fei:register &lt;name&gt;</code>, or ask for the scopes it requires.</p>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it) => { const Icon = iconFor(it.icon); return (
            <li key={it.name}>
              <Link to={it.path} className="group flex h-full flex-col rounded-pso border border-line bg-surface p-4 hover:border-brand">
                <Icon className="h-6 w-6 text-brand" aria-hidden="true" />
                <span className="mt-3 font-medium">{it.title}</span>
                <span className="mt-1 text-xs text-muted">{it.path}</span>
                <FiArrowRight className="mt-auto self-end text-muted group-hover:text-brand" aria-hidden="true" />
              </Link>
            </li>
          ); })}
        </ul>
      )}
    </div>
  );
}
