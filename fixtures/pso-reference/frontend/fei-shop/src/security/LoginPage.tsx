import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FiKey, FiLogIn } from "react-icons/fi";
import { safeReturnTo, useAuth, useFei, useSession } from "@pso/frontend-react";

const field = "block w-full rounded-pso border border-line bg-surface px-3 py-2 font-mono text-xs text-fg";
const primary = "inline-flex items-center gap-2 rounded-pso bg-brand px-4 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-50";

/** Sign-in. The provider comes from the runtime configuration: OpenID Connect (Authorization Code + PKCE) or, in development builds only, a pasted token. */
export function LoginPage() {
  const auth = useAuth();
  const fei = useFei();
  const session = useSession();
  const navigate = useNavigate();
  const loc = useLocation();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const returnTo = safeReturnTo(new URLSearchParams(loc.search).get("returnTo"));
  const expired = session.status === "expired";

  return (
    <main className="mx-auto mt-16 w-full max-w-md px-4">
      <div className="rounded-pso border border-line bg-surface p-6">
        <h1 className="text-xl font-semibold">Sign in to {fei.name.replace(/^fei-/, "")}</h1>
        {expired ? <p role="alert" className="mt-3 rounded-pso bg-surface-2 p-3 text-sm text-warn">Your session ended. Sign in again to continue.</p> : null}
        {auth.kind === "oidc" ? (
          <>
            <p className="mt-2 text-sm text-muted">You will be redirected to your identity provider.</p>
            <button type="button" className={`${primary} mt-6`} onClick={() => { setError(null); auth.signIn(returnTo).catch((e: Error) => setError(e.message)); }} disabled={session.status === "authenticating"}><FiLogIn aria-hidden="true" /> Continue</button>
          </>
        ) : auth.devTokenAllowed ? (
          <form className="mt-4" onSubmit={(e) => { e.preventDefault(); try { auth.signInWithToken(token); setToken(""); navigate(returnTo, { replace: true }); } catch (err) { setError((err as Error).message); } }}>
            <label htmlFor="dev-token" className="text-sm font-medium">Development token</label>
            <p className="mb-2 text-xs text-muted">Create one with <code>pso idp:dev token --scopes …</code>. It stays in memory and is gone when you close or reload the page.</p>
            <textarea id="dev-token" rows={5} className={field} value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} autoComplete="off" aria-describedby={error ? "login-error" : undefined} />
            <button type="submit" className={`${primary} mt-4`} disabled={!token.trim()}><FiKey aria-hidden="true" /> Start session</button>
          </form>
        ) : (
          <p className="mt-3 text-sm text-muted">Sign-in is not configured for this environment. Ask the operator to publish the authentication settings of the application.</p>
        )}
        {error || session.error ? <p id="login-error" role="alert" className="mt-4 text-sm text-bad">{error ?? session.error}</p> : null}
      </div>
    </main>
  );
}
