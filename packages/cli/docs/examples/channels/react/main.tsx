import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createPsoChannels } from "@pso/channels-client";
import { PsoChannelsProvider } from "@pso/react-channels";
import { CandidateEvents } from "./CandidateEvents";

// One client for the whole application. In a real app `getToken` returns your current access token (refresh it there);
// `/api/token` is a stand-in for your login flow.
const params = new URLSearchParams(location.search);
const orchestrator = params.get("orchestrator") ?? location.origin;

const channels = createPsoChannels({
  url: orchestrator.replace(/^http/, "ws") + "/channels",
  getToken: async () => (await fetch(`/api/token${location.search}`)).text(),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PsoChannelsProvider channels={channels}>
      <CandidateEvents candidateId={params.get("candidate") ?? "c1"} />
    </PsoChannelsProvider>
  </StrictMode>,
);
