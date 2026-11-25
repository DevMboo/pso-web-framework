import { FiAlertCircle, FiAlertTriangle, FiCheckCircle, FiInfo, FiX } from "react-icons/fi";
import { useNotifications } from "@pso/frontend-react";

const LEVEL = {
  info: { icon: FiInfo, cls: "text-brand" },
  success: { icon: FiCheckCircle, cls: "text-ok" },
  warning: { icon: FiAlertTriangle, cls: "text-warn" },
  error: { icon: FiAlertCircle, cls: "text-bad" },
} as const;

/** Notifications raised by the shell or by any microfrontend through `usePsoContext().notifications`. */
export function Notifications() {
  const { items, dismiss } = useNotifications();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-end gap-2 p-4" aria-live="polite" aria-atomic="false">
      {items.map((n) => {
        const L = LEVEL[n.level];
        return (
          <div key={n.id} role={n.level === "error" ? "alert" : "status"} className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-pso border border-line bg-surface p-3 shadow-lg">
            <L.icon className={`mt-0.5 h-5 w-5 shrink-0 ${L.cls}`} aria-hidden="true" />
            <div className="min-w-0 flex-1 text-sm">
              {n.title ? <p className="font-semibold">{n.title}</p> : null}
              <p className="break-words text-fg">{n.message}</p>
            </div>
            <button type="button" onClick={() => dismiss(n.id)} className="rounded p-1 text-muted hover:text-fg" aria-label="Dismiss notification"><FiX className="h-4 w-4" aria-hidden="true" /></button>
          </div>
        );
      })}
    </div>
  );
}
