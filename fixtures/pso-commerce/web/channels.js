// PSO Channels over a native WebSocket (wire protocol "pso.channels.v1"): auth, subscribe, ping, events, bounded reconnection.
// Nothing here fabricates an event: every line the console shows was received from the server.
const SUBPROTOCOL = "pso.channels.v1";
const CHANNEL = /^order\.[0-9a-fA-F-]{36}$/; // the only channel the deployed gateway declares

export function createChannels({ getToken, onState, onEvent, onLine }) {
  let ws, state = "closed", seq = 0, attempts = 0, retryTimer, hbTimer, wantOpen = false, authenticated = false;
  const pending = new Map(); const subs = new Set();
  const set = (s, extra = "") => { state = s; onState?.({ state, attempts, extra }); };
  const line = (kind, text, extra = {}) => onLine?.({ at: new Date(), kind, text, ...extra });
  const url = () => `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/channels`;
  const raw = (m) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ v: 1, ...m })); return true; } return false; };
  const request = (m, ms = 15000) => new Promise((resolve, reject) => {
    const id = `p${++seq}`; const timer = setTimeout(() => { pending.delete(id); reject(new Error("no answer from the server")); }, ms);
    pending.set(id, { resolve, reject, timer }); if (!raw({ ...m, id })) { clearTimeout(timer); pending.delete(id); reject(new Error("not connected")); }
  });
  const failPending = (msg) => { for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error(msg)); pending.delete(id); } };

  async function authenticate() {
    const token = getToken();
    if (!token) { line("error", "no token: set one before connecting"); return false; }
    try { await request({ t: "auth", token }); authenticated = true; line("info", "authenticated"); return true; }
    catch (e) { line("error", `authentication refused: ${e.message}`); return false; }
  }
  async function join(channel) {
    try { await request({ t: "subscribe", channel }); line("info", `subscribed to ${channel}`, { channel }); }
    catch (e) { line("error", `subscription to ${channel} refused: ${e.message}`, { channel }); subs.delete(channel); }
  }
  function open() {
    if (!wantOpen) return; set(attempts === 0 ? "connecting" : "reconnecting");
    let sock; try { sock = new WebSocket(url(), SUBPROTOCOL); } catch (e) { line("error", `cannot open: ${e.message}`); return retry(); }
    ws = sock; authenticated = false;
    sock.onopen = async () => {
      const wasRetry = attempts > 0; attempts = 0; set("connected"); line("info", wasRetry ? "reconnected" : "connected");
      clearInterval(hbTimer); hbTimer = setInterval(() => raw({ t: "ping" }), 25000);
      if (await authenticate()) for (const c of subs) await join(c);
    };
    sock.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      const id = typeof m.id === "string" ? m.id : undefined;
      if (m.t === "ack") { const p = pending.get(id); if (p) { clearTimeout(p.timer); pending.delete(id); p.resolve(m.result); } }
      else if (m.t === "error") { const p = pending.get(id); const e = new Error(`${m.code}: ${m.message}`); if (p) { clearTimeout(p.timer); pending.delete(id); p.reject(e); } else line("error", e.message); }
      else if (m.t === "event") onEvent?.({ at: new Date(), receivedAt: Date.now(), eventId: m.eventId, type: m.type, channel: m.channel, ts: m.ts, correlationId: m.correlationId ?? null, payload: m.payload });
    };
    sock.onclose = (ev) => {
      clearInterval(hbTimer); failPending("connection closed"); if (ws === sock) ws = undefined;
      line("warn", `connection closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""})`);
      if (!wantOpen || ev.code === 4426) { set("closed"); return; } retry();
    };
    sock.onerror = () => { /* onclose follows; browsers do not expose the reason */ };
  }
  function retry() {
    if (!wantOpen) return; attempts++; set("reconnecting");
    const delay = Math.min(15000, 500 * 2 ** Math.min(attempts - 1, 6)) * (0.5 + Math.random() / 2);
    line("warn", `reconnecting in ${Math.round(delay)} ms (attempt ${attempts})`); clearTimeout(retryTimer); retryTimer = setTimeout(open, delay);
  }
  return {
    get state() { return state; },
    connect() { if (wantOpen) return; wantOpen = true; attempts = 0; open(); },
    disconnect() { wantOpen = false; clearTimeout(retryTimer); clearInterval(hbTimer); failPending("closed"); try { ws?.close(1000, "client closed"); } catch { /* closed */ } set("closed"); },
    subscribe(channel) { if (!CHANNEL.test(channel)) throw new Error("the deployed gateway declares only order.<order id> channels"); if (subs.has(channel)) return; subs.add(channel); if (state === "connected" && authenticated) void join(channel); else if (!wantOpen) this.connect(); },
    unsubscribe(channel) { if (subs.delete(channel)) raw({ t: "unsubscribe", channel, id: `u${++seq}` }); },
    reauthenticate: async () => { if (state !== "connected") return false; const ok = await authenticate(); if (ok) for (const c of subs) await join(c); return ok; },
    channels: () => [...subs],
  };
}
