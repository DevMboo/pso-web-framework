import { usePsoChannel } from "@pso/react-channels";

/** The payload of the `candidate.updated` event: the same contract the Spring service publishes (CandidateUpdated). */
interface CandidateUpdated { candidateId: string; status: "APPLIED" | "INTERVIEW" | "HIRED" | "REJECTED" }

export function CandidateEvents({ candidateId }: { candidateId: string }) {
  // One subscription while this component is mounted; it follows `candidateId` and is removed on unmount (StrictMode safe).
  const { status, connected, events, error } = usePsoChannel<CandidateUpdated>(`candidate.${candidateId}`, { maxEvents: 50 });

  return (
    <section>
      <h1>Candidate {candidateId}</h1>
      <p>Connection: <strong data-testid="status">{status}</strong>{connected ? "" : " (waiting)"}</p>
      {error && <p role="alert">{error.message}</p>}
      <ul aria-live="polite">
        {[...events].reverse().map((e) => (
          <li key={e.eventId}>{e.type}: {e.payload.candidateId} is now {e.payload.status}</li>
        ))}
      </ul>
    </section>
  );
}
