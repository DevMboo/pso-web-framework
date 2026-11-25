import { defineEvents } from "@pso/dispatch";
import { ChannelEvents } from "./channels.consumer";

// The only event the Channels bridge consumes: services publish channel events to it, the orchestrator delivers them to browsers.
export default defineEvents({
  events: [{ name: "channels.publish", version: 1, channel: "channels-events", key: "channel", schema: {"type":"object","required":["v","id","type","channel","ts","source","payload"],"additionalProperties":false,"properties":{"v":{"type":"integer"},"id":{"type":"string"},"type":{"type":"string"},"channel":{"type":"string"},"ts":{"type":"string"},"correlationId":{"type":"string"},"source":{"type":"string"},"payload":{"type":"object"}}} }],
  consumers: [ChannelEvents],
});
