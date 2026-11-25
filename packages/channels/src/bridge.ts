import { log } from "@pso/http";
import { ChannelError } from "./protocol.ts";
import { ChannelPublisher } from "./server.ts";

/**
 * The bridge between PSO Dispatch (service messaging, brokers, retries, dead letters, outbox) and Channels (delivery to browsers).
 * A service publishes the Dispatch event `channels.publish` whose payload is a channel envelope; this consumer hands it to the hub.
 * Declare it like any Dispatch consumer:
 *
 *   @DispatchConsumer("channels.publish")
 *   export class ChannelEvents extends ChannelDispatchConsumer {}
 *
 * and list it, with the event, in the module's EVENTS.pso.ts. The channel's `publishers` allow-list is checked against the publisher of the
 * Dispatch message; a `source` written inside the payload is always ignored.
 *
 * WHO that publisher is comes from Dispatch trust: `ctx.verifiedSource`, the service whose key signed the message (present with
 * `dispatch.trust.mode=required`, or `permissive` and a signed message). The envelope's `source` field is only a claim that any
 * producer with access to the broker can write, so it never authorizes a publication in production:
 *
 *   - production (PSO_ENV / NODE_ENV): a message without a verified publisher is REFUSED (fail closed), whatever the trust mode;
 *   - explicit legacy migration: PSO_CHANNELS_BRIDGE_ALLOW_UNVERIFIED=true accepts the claimed source again. It is insecure by
 *     declaration (reported when first used, and counted), meant only for the time unsigned publishers still exist;
 *   - development and tests: the claimed source is accepted with a one-time warning, so nothing has to be configured locally.
 *
 * Invalid or refused events are logged and dropped (retrying a malformed event cannot succeed and would only fill the dead-letter channel); a
 * temporarily unavailable bus is re-thrown so Dispatch retries it.
 */
const warnedUnverified = new Set<string>(); // one notice per policy and process, not one per event
let refused = 0;
/** What the bridge does with a message whose publisher is not verified, decided from the environment of the process. */
export function unverifiedBridgePolicy(env: Record<string, string | undefined> = process.env): "refuse" | "legacy" | "development" {
  const production = (env["PSO_ENV"] ?? env["NODE_ENV"] ?? "development") === "production";
  if (!production) return "development";
  return env["PSO_CHANNELS_BRIDGE_ALLOW_UNVERIFIED"] === "true" ? "legacy" : "refuse";
}
export abstract class ChannelDispatchConsumer {
  async handle(payload: unknown, ctx: { envelope: { source: string }; verifiedSource?: string }): Promise<void> {
    let source = ctx.verifiedSource;
    if (source === undefined) {
      const policy = unverifiedBridgePolicy();
      if (policy === "refuse") {
        refused++;
        if (refused <= 10 || refused % 100 === 0) log("error", "channel event from dispatch REFUSED: its publisher is not verified. Sign Dispatch messages (PSO_DISPATCH_SIGNING_KEY on the publishing service, PSO_DISPATCH_TRUST_KEY_<SERVICE> here) and set dispatch.trust.mode=required; for a temporary legacy migration set PSO_CHANNELS_BRIDGE_ALLOW_UNVERIFIED=true (insecure)", { component: "channels", claimedSource: String(ctx.envelope.source).slice(0, 64), refused });
        return; // dropped, like any refused event: retrying cannot make it authentic
      }
      if (!warnedUnverified.has(policy)) {
        warnedUnverified.add(policy);
        log("warn", policy === "legacy"
          ? 'INSECURE legacy mode (PSO_CHANNELS_BRIDGE_ALLOW_UNVERIFIED): channel events from Dispatch are authorized on an unauthenticated "source"; any producer on the broker can name an allowed publisher. Sign Dispatch messages and remove this setting'
          : 'channel events from Dispatch are accepted on an unauthenticated "source" (development only: production refuses them). Sign Dispatch messages (PSO_DISPATCH_SIGNING_KEY on services, PSO_DISPATCH_TRUST_KEY_<SERVICE> here) and set dispatch.trust.mode=required', { component: "channels" });
      }
      source = ctx.envelope.source; // a claim, accepted only by the two explicit policies above
    }
    try { await new ChannelPublisher().ingest(payload, source); }
    catch (e) {
      if (e instanceof ChannelError && e.code === "PSO_CHANNEL_UNAVAILABLE") throw e;
      log("warn", "channel event from dispatch dropped", { source: ctx.envelope.source, reason: (e as Error).message.split("\n")[0]!.slice(0, 200) });
    }
  }
}
