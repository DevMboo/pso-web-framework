import type { PsoApi } from "@pso/frontend";
import type { Item } from "../models/item.ts";

/**
 * All calls this microfrontend makes to the backend. They go to the orchestrator through the `api` the host provides: the client adds the
 * credentials, a correlation id, a timeout and turns RFC 9457 Problem Details into typed errors. Never build absolute URLs here.
 */
export const usersService = (api: PsoApi) => ({
  findAll: (signal?: AbortSignal) => api.get<Item[]>("/accounts/users", signal ? { signal } : {}),
  findById: (id: string, signal?: AbortSignal) => api.get<Item>(`/accounts/users/${encodeURIComponent(id)}`, signal ? { signal } : {}),
});
