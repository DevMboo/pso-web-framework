import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ActiveRoute } from "@pso/core";
import type { TraceContext } from "./telemetry.ts";

/** What the framework knows about the request being handled: its correlation id, the declared route that matched and its trace. */
export interface RequestContext { correlationId: string; route: ActiveRoute; trace: TraceContext }
/** The same, with the request and response objects: what code running inside an action can reach without receiving them as parameters. */
export interface CurrentRequest extends RequestContext { req: IncomingMessage; res: ServerResponse }

export const contexts = new WeakMap<IncomingMessage, RequestContext>();
/** requests whose multipart body was abandoned half-way: the answer must drain what is still arriving, then close */
export const midstream = new WeakSet<IncomingMessage>();
/** raw request bodies already consumed by @Body(), so a later forward() can still send them */
export const rawBodies = new WeakMap<IncomingMessage, Buffer>();

const store = new AsyncLocalStorage<CurrentRequest>();
/** Runs an action with its request as the current one (per asynchronous call chain: concurrent requests never see each other). */
export const runWithRequest = <T>(current: CurrentRequest, fn: () => T): T => store.run(current, fn);
/** The request being handled by the calling code, or undefined outside a request (start-up, an event consumer, a timer). */
export const currentRequest = (): CurrentRequest | undefined => store.getStore();
