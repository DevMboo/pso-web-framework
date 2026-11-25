import { DispatchConsumer } from "@pso/dispatch";
import { ChannelDispatchConsumer } from "@pso/channels";

// The Dispatch envelope's `source` (the authenticated publisher) is checked against each channel's `publishers` list.
@DispatchConsumer("channels.publish", { group: "orchestrator-channels" })
export class ChannelEvents extends ChannelDispatchConsumer {}
