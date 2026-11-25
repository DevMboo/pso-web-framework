import { createPsoChannels } from "./client.js";

// Where the orchestrator is, and who is logged in. In a real application the token comes from your login flow (the same access token
// your HTTP calls send); `/api/token` below is a stand-in for it.
const params = new URLSearchParams(location.search);
const candidateId = params.get("candidate") ?? "c1";
const orchestrator = params.get("orchestrator") ?? location.origin; // e.g. https://api.example.com

const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const eventsEl = document.getElementById("events");
document.getElementById("candidate").textContent = candidateId;

const channels = createPsoChannels({
  url: orchestrator.replace(/^http/, "ws") + "/channels",
  // called after every (re)connection and shortly before the token expires; the token never goes in the URL
  getToken: async () => (await fetch(`/api/token${location.search}`)).text(),
  onStateChange: (state) => { statusEl.textContent = state; },
  onError: (e) => showError(e.message),
});

function showError(message) { errorEl.textContent = message; errorEl.hidden = false; }

// The server authorizes THIS candidate for THIS user: a user who may not see it gets "Not allowed." and no events.
const subscription = channels.subscribe(`candidate.${candidateId}`, {
  onSubscribed: (active) => { statusEl.textContent = active ? "subscribed" : "not subscribed"; if (active) errorEl.hidden = true; },
  onEvent: (event) => {
    const li = document.createElement("li");
    li.textContent = `${event.type}: ${event.payload.candidateId} is now ${event.payload.status}`; // textContent, never innerHTML: payloads are data
    eventsEl.prepend(li);
  },
  onError: (e) => showError(e.message),
});

// stop cleanly when the page goes away
addEventListener("pagehide", () => { subscription.unsubscribe(); channels.close(); });
