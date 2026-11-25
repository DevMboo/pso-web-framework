import { Injectable } from "@pso/http";
import type { Principal } from "@pso/security";

/**
 * Who may subscribe to which RESOURCE. The channel already requires the orders:read scope; this rule is the resource-level part.
 * In this validation application every orders:read holder may follow any order (there is no per-customer ownership model).
 */
@Injectable()
export class OrderAccess {
  canSubscribe(user: Principal | null, resource: { orderId: string }): boolean {
    return user !== null && user.hasScope("orders:read") && /^[0-9a-f-]{36}$/.test(resource.orderId);
  }
}
