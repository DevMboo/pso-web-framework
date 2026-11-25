import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PsoProvider, useChannel, usePsoConnection } from "./integrations/pso/channels";

// Your application's session. Here the user comes from the URL and the token from a stand-in endpoint; use your authentication library.
const initialUser = new URLSearchParams(location.search).get("user") ?? "alice";
const getAccessToken = (user: string) => async () => (await fetch(`/api/token?user=${user}`)).text();

function Candidate({ id }: { id: string }) {
  // Typed from the generated contract: `events` is a union discriminated by `type`, `candidateId` is the channel parameter.
  const { status, events, error } = useChannel("candidate.{candidateId}", { candidateId: id });
  return (
    <section>
      <p>channel: <b id="channel">{status}</b></p>
      {error && <p id="error">{error.message}</p>}
      <ul>
        {events.map((e) => (e.type === "candidate.updated" ? <li key={e.eventId}>{e.payload.candidateId} is now {e.payload.status}</li> : null))}
      </ul>
    </section>
  );
}

function Panel({ user, onSwitch }: { user: string; onSwitch: () => void }) {
  const [shown, setShown] = useState(true);
  const { state } = usePsoConnection(); // the shared connection: one WebSocket for the whole application
  return (
    <>
      <p>connection: <b id="state">{state}</b> user: <b id="who">{user}</b></p>
      <button id="toggle" onClick={() => setShown((s) => !s)}>toggle</button>
      <button id="bob" onClick={onSwitch}>switch user</button>
      {shown && <Candidate id="c1" />}
    </>
  );
}

function Shell() {
  const [user, setUser] = useState(initialUser);
  // `sessionKey` changes with the user: the connection re-authenticates and the server re-authorizes every subscription.
  return (
    <PsoProvider getToken={getAccessToken(user)} sessionKey={user}>
      <Panel user={user} onSwitch={() => setUser("bob")} />
    </PsoProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Shell />);
