import { Channel, OnSubscribe, Context, ChannelParam } from "@pso/channels";
import type { ChannelContext } from "@pso/channels";
import { Scopes } from "@pso/http";
import { OrderAccess } from "./order-access";
import { OrderEventDto } from "./dto/order-event.dto";

@Channel("order.{orderId}", { visibility: "private", publishers: ["orders"], events: { "order.updated": OrderEventDto } })
export class OrderChannel {
  constructor(private readonly access: OrderAccess) {}

  @OnSubscribe()
  @Scopes("orders:read")
  async authorize(@ChannelParam("orderId") orderId: string, @Context() context: ChannelContext): Promise<boolean> {
    return this.access.canSubscribe(context.user, { orderId });
  }
}
