---
title: Channels (real-time)
description: Declare WebSocket channels with decorators, register them in MODULE.pso.ts, authorize every subscription against the resource, publish typed events from Spring Boot through Dispatch, and connect browsers with the client SDK.
order: 10
status: stable
keywords: [channels, websocket, realtime, "@Channel", OnSubscribe, OnEvent, ChannelParam, Payload, presence, ChannelPublish, PsoChannelPublisher, createPsoChannels, usePsoChannel, make:channel, channels:enable, PSO_CHANNELS_BUS]
related: [orchestrator/dto-validation, orchestrator/module, security/authorization, dispatch/overview, dispatch/outbox, spring/dispatch, reference/environment-variables]
---
## What it is

PSO Channels delivers real-time events to browsers over WebSocket, on the **same HTTP server** as your routes. Three responsibilities stay separate:

| Piece | Owns |
|---|---|
| **Channels** (`@pso/channels`) | connections, subscriptions, authorization, client commands, delivery, presence, limits, heartbeats |
| **Channel registry** (`channels: [...]` in `MODULE.pso.ts`) | which channel classes exist, their names, contracts and who may publish |
| **PSO Dispatch** | inter-service messaging, brokers, retries, dead letters, the transactional outbox |

Channels is **not a message broker**. A browser connection is not a durable queue: an event published while a client is offline is not replayed, and the SDK never claims otherwise.

## 1. Declare and register a channel

```typescript
import { Channel, OnSubscribe, OnEvent, OnDisconnect, Payload, Client, Context, ChannelParam } from "@pso/channels";
import type { ChannelClient, ChannelContext } from "@pso/channels";
import { Scopes } from "@pso/http";

@Channel("/recruitment", { visibility: "private" })
export class RecruitmentChannel {
  @OnSubscribe()
  @Scopes("recruitment:read")
  async authorize(@Context() context: ChannelContext): Promise<boolean> {
    return context.user !== null;
  }

  @OnEvent("candidate.subscribe")
  @Scopes("candidate:read")
  async subscribeCandidate(@Payload(CandidateSubscriptionDto) payload: CandidateSubscriptionDto, @Client() client: ChannelClient) {
    await client.join(`candidate.${payload.candidateId}`); // goes through the SAME authorization as a direct subscribe
    return { joined: payload.candidateId };
  }

  @OnDisconnect()
  async disconnect(@Client() client: ChannelClient): Promise<void> { /* optional cleanup */ }
}

@Channel("candidate.{candidateId}", { visibility: "private", publishers: ["recruitment-service"], events: { "candidate.updated": CandidateUpdatedDto } })
export class CandidateChannel {
  constructor(private readonly access: CandidateAccess) {}           // normal dependency injection

  @OnSubscribe()
  async authorize(@ChannelParam("candidateId") candidateId: string, @Context() context: ChannelContext): Promise<boolean> {
    return this.access.canRead(context.user, candidateId);          // the RESOURCE, not just "is logged in"
  }
}
```

```typescript
// src/modules/recruitment/MODULE.pso.ts
export default defineModule({
  name: "recruitment", controllers: [RecruitmentController], providers: [CandidateAccess],
  channels: [RecruitmentChannel, CandidateChannel],      // explicit: a decorated class that is not listed here stays INACTIVE
  routes, imports: [], exports: [],
});
```

Decorators only attach metadata. Nothing is scanned: a class is active only when a module lists it. Start-up refuses (naming the module and class): a class without `@Channel`, a channel registered twice or in two modules, two patterns that can match the same name (`zone.{id}` and `zone.north`), a duplicate handler, a `@ChannelParam` the pattern does not have, a `@Payload` that is not a `@Dto`, an internal channel with client handlers, a public channel handler without `@Public()`, and a **private or presence channel with parameters but no `@OnSubscribe`** (authentication alone never grants access to a resource).

Authentication and permissions reuse what you already know: handlers require an authenticated caller unless marked `@Public()`, and `@Scopes(...)` has the same meaning as on an HTTP action. Generate the files with:

```bash
pso make:channel recruitment candidate --service gw --pattern "candidate.{candidateId}" \
  --publisher recruitment-service --event candidate.updated --fields "candidateId:string,status:enum=APPLIED|INTERVIEW|HIRED"
pso channels:validate --service gw
```

The generated access provider **starts closed** (every subscription refused) until you write the rule.

| Visibility | Rule |
|---|---|
| `private` (default) | authenticated, scopes, then the channel's own `@OnSubscribe` |
| `public` | may be subscribed without authentication, only when you declare it; never publish sensitive data here |
| `presence` | private plus participant tracking (opaque subject ids, shown only to authorized subscribers, one participant for several connections) |
| `internal` | never subscribable by clients (it looks like a channel that does not exist); only declared publishers and in-process `onInternal` listeners |

## 2. Four separate decisions

| Decision | Where it is made |
|---|---|
| may this connection exist | origin check, authentication, `@OnConnect` |
| may it subscribe to this channel | visibility, `@Scopes`, `@OnSubscribe` with the resolved parameters; a denial and a resource that does not exist give the **same** `PSO_CHANNEL_FORBIDDEN` |
| may it send this client event | subscribed to the channel, `@Scopes`, `@OnEvent` exists, DTO valid |
| may a service publish | the channel's `publishers` list against the **publisher of the Dispatch message**, and the `events` contract. The publisher is authenticated only when Dispatch publisher trust is on (`dispatch.trust.mode`, see [Dispatch security](/dispatch/security-and-observability)); without it the envelope's `source` is a claim any producer on the broker can write, and the orchestrator logs that once |

A client frame can only reach an `@OnEvent` method: there is no way to invoke a service method or to produce a `t:"event"` frame other clients receive. Client commands and server events use different frame types and different paths.

## 3. Publish from a Spring Boot service

```bash
pso channels:enable --service recruitment-service      # starter, pso.channels, the channels.publish event
pso channels:enable --service gw                       # the orchestrator side: Dispatch consumer + @pso/channels
pso make:notifier candidate --service recruitment-service --channel "candidate.{candidateId}" \
  --event candidate.updated --fields "candidateId:string,status:string" --durable
```

In a layered service `make:notifier` writes the payload record to `application/event/CandidateEvent.java` and the publishing service
to `application/service/CandidateNotifier.java`; a 0.1 service gets `events/` and `application/`.

```java
@Service
public class RecruitmentNotificationService {
    private final PsoChannelPublisher publisher;
    public RecruitmentNotificationService(PsoChannelPublisher publisher) { this.publisher = publisher; }

    public void notifyCandidateUpdated(UUID candidateId, CandidateStatus status) {
        publisher.publish("candidate." + candidateId, "candidate.updated", new CandidateUpdated(candidateId, status));
    }
}
```

```java
@Transactional
@ChannelPublish(channel = "candidate.{candidateId}", event = "candidate.updated", delivery = PsoChannelPublisher.Delivery.DURABLE)
public CandidateUpdated updateCandidate(UpdateCandidateCommand command) {
    Candidate c = repository.findById(command.candidateId()).orElseThrow();
    c.updateStatus(command.status());
    return new CandidateUpdated(c.getId(), c.getStatus());
}
```

The event travels as the Dispatch event `channels.publish`; the service never knows an orchestrator address or a connection. Dispatch must be enabled with a provider; the envelope `source` is the service's own name.

### Delivery semantics (explicit)

| `Delivery` | Behaviour | If something fails |
|---|---|---|
| `BEST_EFFORT` (default) | inside a transaction: sent **after commit**, never on rollback; outside one: sent now | after commit the transport can fail and the event is **lost** (logged, counted in `metrics().failedAfterCommit`) |
| `DURABLE` | written to the transactional **outbox in the same transaction** as your data and relayed with the framework's retries | no transaction or no outbox: it **fails**, it is never downgraded. At-least-once; stable event id; the orchestrator suppresses duplicates it already delivered. Not exactly-once |

`PsoChannelPublisher.publish` returns an `Outcome` (`SENT`, `SCHEDULED_AFTER_COMMIT`, `STORED_IN_OUTBOX` and what the transport acknowledged). `@ChannelPublish` publishes the **return value** once per invocation after the method returns normally (`null` publishes nothing, an exception publishes nothing, `{property}` placeholders in the channel come from the returned record). It works through the Spring proxy: self-invocation and private methods are not intercepted; void, primitive, String or collection returns are refused at start-up. Commit-before-publish is not delivery: a committed `BEST_EFFORT` event can still be lost, which is why `DURABLE` exists.

For consuming durable events between services keep using `@PsoEventHandler` and `@DispatchConsumer`: Channels has no listener annotation of its own.

## 4. Connect the browser

```typescript
import { createPsoChannels } from "@pso/channels-client";

const channels = createPsoChannels({ url: "/channels", getToken: () => session.accessToken() });
const subscription = channels.subscribe("candidate.3f2a", { onEvent(e) { console.log(e.type, e.payload); }, onError(err) { console.warn(err.code); } });
subscription.unsubscribe();
```

```typescript
import { PsoChannelsProvider, usePsoChannel } from "@pso/react-channels";   // React 18+ is a peer dependency

function Candidate({ id }: { id: string }) {
  const { status, connected, events, error } = usePsoChannel(`candidate.${id}`);
  ...
}
```

The token is sent in an `auth` frame after the socket opens (never in the URL), renewed before it expires, and repeated after every reconnect. Reconnection uses bounded exponential backoff with jitter; after reconnecting every active subscription is **requested again so the server re-authorizes it** (a subscription that is no longer allowed is reported through `onError`, not retried). There is no offline queue and no automatic replay of commands (`send()` rejects while disconnected), and no event replay. The hook subscribes once per mounted component, unsubscribes on unmount and when the channel changes, keeps a bounded event list (`maxEvents`) and survives StrictMode.

## Install the React integration

From the root of an **existing** React + TypeScript application (it never creates a project):

```bash
pso install:react channels                        # inside a PSO workspace the orchestrator contracts are found automatically
pso install:react channels --contracts ../gw      # or name the orchestrator folder
pso install:react channels --dry-run              # show the packages and files without changing anything
```

What it does, in order: finds the project root, confirms React 18 or later and a `tsconfig`, detects the package manager from the `packageManager` field or the lockfile (npm, pnpm or Yarn; a conflict between them is refused), reports whether the integration is not installed, partly installed or complete, installs the two official packages **with that package manager**, writes the application-owned files that do not exist yet, and type-checks them with the project's own TypeScript options. If the installation fails, `package.json` and the lockfile are restored and no file is written. Running it again changes nothing; deleting a generated file and running it again restores only that file. A file that already exists and was not written by PSO is never overwritten (the command stops and names it); it never edits `App.tsx` or your router, never installs globally and never runs a downloaded script.

| Installed | Purpose |
|---|---|
| `@pso/channels-client` | the framework-independent SDK: the single connection, authentication, reconnection, heartbeat, subscriptions (no dependencies) |
| `@pso/react-channels` | React 18+ bindings over the SDK: they only tie subscriptions to component lifecycles and never open a socket of their own |

| Generated (in `src/integrations/pso/`, or `--dir`) | Content |
|---|---|
| `client.ts` | how to obtain your **current access token** (`TokenProvider`) and where the orchestrator is (`VITE_PSO_CHANNELS_URL`, `REACT_APP_PSO_CHANNELS_URL`, or `globalThis.PSO_CHANNELS_URL`, by bundler; default `/channels` on the page's own origin) |
| `channels.ts` | typed hooks bound to the contracts: `PsoProvider`, `useChannel`, `sendCommand`, `channelName`, `usePsoConnection` |
| `types.ts` | the generated, client-safe contracts (marked `pso:generated`; regenerate with `pso channels:contracts --from <orchestrator>`) |

The files are small and import the SDK; nothing of the SDK is copied into your project. After installation the command prints the provider snippet to add by hand. This is the code the repository test runs, in a real React app, against a real orchestrator in a real browser:

:::include file="examples/channels/installed/main.tsx" title="src/main.tsx (written by you)"

**Contracts and types.** `types.ts` lists the registered, non-internal channels with the type of each name parameter and the payload types of their server events and client commands, read statically from your `@Channel` classes and `@Dto` DTOs. It contains no publishers, scopes, authorization methods, unregistered or internal channels, and no addresses; generation warnings go to the console, never into the file. It makes `useChannel("candidate.{candidateId}", { candidateId })` type-checked and `events` a union discriminated by `type`. It is a typing aid, not access control: the server decides every subscription.

**Authentication.** The integration plugs into the authentication you already have: `getToken` returns your current access token (refresh it there). Nothing is stored in browser storage, the token is sent in an `auth` frame (never in the URL) after every connection and shortly before expiry, and `sessionKey` makes the connection re-authenticate when the user changes: the server re-authorizes every subscription (and, since a socket never changes identity, a different user reconnects). `enabled={false}` (for example while logged out) closes the connection. An expired token ends the authorized subscriptions; `usePsoConnection().error` and `useChannel(...).error` report it. Cookie sessions are not used by the protocol, so there is nothing for a cross-site WebSocket hijack to ride on; the orchestrator additionally refuses browser origins that are not in `allowedOrigins`. The client refuses `ws://` to any host except localhost: use `wss://` outside development.

| Environment | Setting |
|---|---|
| development | endpoint `ws://localhost:3000/channels`; the orchestrator accepts the same origin, or list your dev server in `PSO_CHANNELS_ALLOWED_ORIGINS=http://localhost:5173` |
| production | `wss://api.example.com/channels` in the build-time variable; `PSO_CHANNELS_ALLOWED_ORIGINS=https://app.example.com`; `bus: redis` for several orchestrator instances |

Unsupported targets are refused with the reason: no `react` dependency, React older than 18, no `tsconfig`, TypeScript not installed, no `src/` folder (pass `--dir`), conflicting lockfiles, or a `--dir` outside the project. `--skip-install` writes only the files and prints the exact packages to add yourself.

## Front-end examples: connecting a page to the orchestrator

Both examples below are real files (`docs/examples/channels/`) that the repository tests run in a **real browser** (headless Edge or Chrome) against a **real orchestrator**: the page authenticates, subscribes to `candidate.c1`, receives the `candidate.updated` event the application publishes, and a second user who may not see that candidate gets `Not allowed.` and no events. A page served from an origin that is not in `allowedOrigins` is refused before the upgrade.

What the orchestrator needs, for either front end:

```bash
# the origin that serves your page (exact; no wildcard). Development accepts the same origin only.
PSO_CHANNELS_ALLOWED_ORIGINS=https://app.example.com
```

and a way for the page to get the **access token** your login already issues. The examples call `/api/token` as a stand-in for your login flow; replace `getToken` with your own function (it is called after every connection and shortly before expiry, so refresh the token there). The token travels in an `auth` frame, never in the URL.

### Plain HTML and JavaScript

The client SDK (`@pso/channels-client`) is a single dependency-free ES module. Copy `node_modules/@pso/channels-client/dist/index.js` next to the page as `client.js` (or let your bundler resolve `@pso/channels-client`).

:::include file="examples/channels/index.html" title="index.html"

:::include file="examples/channels/app.js" title="app.js"

Open it with `?orchestrator=https://api.example.com&candidate=c1`. The page shows the connection state, the events (newest first) and, if the server refuses the subscription, the fixed message `Not allowed.`. It writes events with `textContent`, never `innerHTML`: payloads are data, not markup.

### React and TypeScript

The React adapter is `@pso/react-channels` (React 18 or later is a peer dependency; the core SDK never imports React). Create one client, provide it once, and use the hook where the data is needed.

:::include file="examples/channels/react/main.tsx" title="main.tsx"

:::include file="examples/channels/react/CandidateEvents.tsx" title="CandidateEvents.tsx"

The hook subscribes once while the component is mounted, follows `candidateId` when it changes, unsubscribes on unmount (also under `StrictMode`) and keeps at most `maxEvents` events. `status` is `loading`, `connected`, `disconnected` or `error`; an authorization refusal arrives as `error` with the fixed code and text. The example type-checks under `--strict`, and the event payload type mirrors the contract the Spring service publishes (`CandidateUpdated`).

### Both examples against the server side of this page

The orchestrator side is the `CandidateChannel` of section 1 (resource-level `@OnSubscribe`, `publishers: ["recruitment-service"]`); the service side is the notifier of section 3. The event the page shows is exactly the `candidate.updated` payload the Spring service sends through Dispatch. After a reconnect the page re-authenticates and the server re-authorizes the subscription, but it does not replay events missed while offline: fetch the current state over HTTP when the connection comes back.

## 5. Protocol, limits and errors

Version 1, JSON text frames, subprotocol `pso.channels.v1`. Client frames: `auth`, `subscribe`, `unsubscribe`, `event`, `ping`. Server frames: `ready`, `ack`, `error`, `event`, `presence`, `unsubscribed`, `pong`. A server event carries `eventId`, `type`, `channel`, `ts`, `correlationId` and `payload`; the internal `source` is never sent to browsers. Errors have a stable code and a fixed text and nothing else:

| Code | Meaning |
|---|---|
| `PSO_CHANNEL_UNAUTHENTICATED` / `_TOKEN_EXPIRED` | no valid identity / credentials expired (authorized subscriptions end; renew with an `auth` frame) |
| `PSO_CHANNEL_FORBIDDEN` | not allowed (also for a resource that does not exist) |
| `PSO_CHANNEL_INVALID_CHANNEL` | unknown, malformed or internal channel |
| `PSO_CHANNEL_UNKNOWN_EVENT`, `_INVALID_PAYLOAD` | no such `@OnEvent`; DTO errors with field **names** only |
| `PSO_CHANNEL_PAYLOAD_TOO_LARGE`, `_RATE_LIMITED`, `_SUBSCRIPTION_LIMIT` | limits |
| `PSO_CHANNEL_UNSUPPORTED_VERSION`, `_BAD_FRAME` | protocol errors |
| `PSO_CHANNEL_UNAVAILABLE`, `_INTERNAL`, `_SLOW_CONSUMER` | transport or server problems |

Before the upgrade the problems are HTTP (RFC 9457): `403` wrong Origin, `401` bad Authorization header, `404` wrong path, `503` full. After it they are protocol frames and close codes (`4401` unauthenticated, `4403` forbidden, `4408` idle, `4426` bad version, `4429` slow consumer, `1009` too big).

Authentication: an `Authorization: Bearer` header on the upgrade (non-browser clients) or an `auth` frame within `authTimeoutMs`; both use the framework's JWT verification (signature, issuer, audience, expiry). Renewal for another subject closes the connection. **Origin** is validated: allowed origins must be listed (development accepts the same origin only). Cookies are not used for authentication, so cross-site hijacking has nothing to ride on.

| Setting (`pso.config.json` `channels.*` or variable) | Default | |
|---|---|---|
| `enabled` / `PSO_CHANNELS_ENABLED` | `true` when a module registers channels | `false` switches Channels off |
| `path` / `PSO_CHANNELS_PATH` | `/channels` | |
| `allowedOrigins` / `PSO_CHANNELS_ALLOWED_ORIGINS` | none | exact origins; required in production; `*` refused |
| `allowAnonymous` | `false` | not allowed in production |
| `authTimeoutMs`, `heartbeatMs`, `idleTimeoutMs` | 10 s, 30 s, 15 min | ping/pong liveness and idle close |
| `maxConnections`, `maxSubscriptionsPerConnection` | 1000, 50 | |
| `maxMessageBytes` | 65536 | enforced while receiving (close `1009`) |
| `ratePerSecond`, `burst` | 20, 40 | token bucket per connection |
| `maxBufferedBytes` | 1 MiB | a client that cannot keep up is closed, never buffered without limit |
| `bus` / `PSO_CHANNELS_BUS`, `redisUrl` / `PSO_CHANNELS_REDIS_URL` | `local` | `redis` for several orchestrator instances |

Spring: `pso.channels.enabled`, `dispatch-event` (`channels.publish`), `max-payload` (`32KB`).

## 6. Several instances

`bus: local` delivers only to the connections of the instance that receives the event: right for development and a single orchestrator, **not distributed**. With several instances use `bus: redis`: every instance fans events out to the connections it owns (duplicates are suppressed by event id; there is no global connection table and no authorization state outside the instance). **Production refuses the local bus** unless `PSO_CHANNELS_ACK_SINGLE_INSTANCE=true` states that exactly one instance runs. The Redis bus is fire-and-forget. An event received from Redis gets the same checks as a local publication before any fan-out (envelope structure and size, registered channel, source allowed for that channel, declared event type and payload contract); a refused event is counted (`busRejected`), logged without its content and dropped, and a received event is never published again. Those checks prove an event is well-formed and permitted, not who sent it. Set `PSO_CHANNELS_BUS_SECRET` (at least 32 characters, the same value on every instance, environment only) to sign bus messages: an instance then delivers only messages with a valid signature (`PSO_CHANNELS_BUS_SECRET_PREVIOUS` keeps the old secret valid while rotating). Without the secret, anyone able to publish to the Redis topic can make instances deliver contract-valid events, so restrict the Redis user with ACLs; production logs a warning. Upgrade every instance before setting the secret: an instance with the secret drops unsigned messages. The bus, its validation and the signed mode are tested against a live Redis (`packages/channels/test/bus.test.ts`).

### Production policy for the two distributed boundaries

| Boundary | Production (`PSO_ENV` / `NODE_ENV` = `production`) | Explicit, insecure legacy switch | Development |
|---|---|---|---|
| Redis bus between instances | start-up is refused without `PSO_CHANNELS_BUS_SECRET` | `PSO_CHANNELS_BUS_ALLOW_UNAUTHENTICATED=true` | no secret needed |
| Dispatch bridge (`ChannelDispatchConsumer`) | an event whose publisher is not **verified** by Dispatch trust is refused and logged; the envelope's `source` never authorizes a publication | `PSO_CHANNELS_BRIDGE_ALLOW_UNVERIFIED=true` | the claimed `source` is accepted, with one warning |

Both switches must be exactly `true`, are reported in the log (`INSECURE legacy mode`) and exist only to keep an existing installation running while keys are rolled out; neither is implied by an incomplete configuration. A weak or missing secret is an error, never a fallback to an unauthenticated bus.

To move a running fleet to a signed bus without losing events: (1) give every instance `PSO_CHANNELS_BUS_SECRET` together with `PSO_CHANNELS_BUS_ACCEPT_UNSIGNED=true`, one instance at a time (each signs what it publishes and still delivers unsigned messages, counting and logging every one); (2) when no `UNSIGNED message was accepted` warning appears any more, remove `PSO_CHANNELS_BUS_ACCEPT_UNSIGNED`. A message that carries a signature must always verify, also during the migration. For the bridge: give the publishing services `PSO_DISPATCH_SIGNING_KEY`, the orchestrator `PSO_DISPATCH_TRUST_KEY_<SERVICE>` and `dispatch.trust.mode: required` ([publisher authentication](/dispatch/security-and-observability)).

## What was verified

The hub, registry, protocol, limits and configuration are unit tested with hostile inputs; heartbeats (a silent peer is terminated), the idle timeout, backpressure (a non-reading client is closed and released), presence and graceful shutdown are tested over real sockets; a real orchestrator process with real WebSockets and the client SDK is tested end to end (subscription, resource authorization, delivery, denial, cleanup, reconnection); the Spring publisher is tested with real transactions, the real outbox class and the real Dispatch runtime on its **in-memory adapter** (it proves what is handed to Dispatch and when, not broker behaviour). Not verified: a browser-based UI, the Redis bus, and the chain Spring service to a real broker to the orchestrator.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `pso install:react channels` says a file "was not written by PSO" | a file with that name already exists | move it, or choose another folder with `--dir` (it is never overwritten) |
| the installer reports conflicting lockfiles or a package manager mismatch | two lockfiles, or `packageManager` disagrees with the lockfile | keep one lockfile or fix the field |
| `types.ts` has no channels | no orchestrator was found | `pso channels:contracts --from <orchestrator>` |
| a decorated channel does nothing | not listed in `channels` of `MODULE.pso.ts` | register it; `pso channels:validate` warns |
| start-up: "needs an @OnSubscribe method that authorizes the requested resource" | resource channel without an authorizer | add `@OnSubscribe` with the rule |
| upgrade `403` from a browser | Origin not allowed | add the origin to `allowedOrigins` |
| closed with `4401` after a few seconds | no `auth` frame (or `getToken` failed) | pass `getToken` to the client |
| `PSO_CHANNEL_FORBIDDEN` for every resource | the generated access provider is closed | write `canSubscribe` |
| the page never connects and the console shows a refused WebSocket | the page origin is not in `allowedOrigins`, or a relative `url` points at the page server instead of the orchestrator | list the origin; pass the orchestrator address (`wss://api.example.com/channels`) |
| events from Spring never arrive | event not declared, Dispatch disabled, source not in `publishers` | `pso channels:enable`; enable Dispatch; list the service in `publishers` (refused events are logged as `channel event from dispatch dropped`) |
| events arrive on one instance only | `bus: local` with several instances | `bus: redis` |
| `DURABLE` fails | no transaction or no outbox | `@Transactional` and `pso.dispatch.outbox.enabled=true` |

## Common mistakes

| Mistake | Fix |
|---|---|
| treating the channel name as a secret or as access control | authorize in `@OnSubscribe` against the resource |
| authorizing a parameterized channel with `context.user !== null` | check ownership, assignment or tenant |
| publishing sensitive data to a `public` channel | keep it private |
| expecting a reconnecting client to receive what it missed | it does not: fetch current state over HTTP after reconnecting |
| using Channels instead of Dispatch for service-to-service work | Dispatch consumers; Channels is for browsers |

## Next steps

- [Dispatch overview](/dispatch/overview) and the [outbox](/dispatch/outbox) for durable publication.
- [Validate request bodies with DTOs](/orchestrator/dto-validation): the same `@Dto` classes validate `@Payload`.
