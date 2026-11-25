---
title: Dispatch graph, inspect and Studio
description: How to see the declared topology and the live connection status, and what the views never fabricate.
order: 9
status: partial
keywords: [studio, dispatch:graph, dispatch:inspect, topology, mermaid]
related: [dispatch/overview, dispatch/installation, devops/studio]
---
Everything shown comes from two honest sources and the views say which:

- **Declared**: read statically from `EVENTS.pso.ts`, `*.events.json` and the configuration. No code runs and no broker is contacted.
- **Live**: an explicit, opt-in connection probe (`pso dispatch:doctor`, or the probe button in Studio) that connects with the configured environment variables, reads the adapter health and disconnects.

```bash
pso dispatch:graph            # services, events, channels, producers and consumers
pso dispatch:graph --mermaid  # the same as a Mermaid diagram
pso dispatch:events           # declared events with version, channel, schema yes/no
pso dispatch:consumers        # who consumes what, in which group
```

Studio's **Dispatch** view lists each service's provider, enabled state, declared events and consumers, the validation findings and, on request, the probe result. It is read-only (Studio never publishes, consumes or edits). When a running service exposes the diagnostics endpoint, the view also shows the **measured** counters (published, consumed, failed, retried, dead-lettered, poison, duplicates) and the adapter's own health; consumer **lag** and dead-letter **depth** are shown as unavailable because they are not exported. Studio does not invent numbers: a service that is not running or not instrumented says so.

## What the commands print

Expected output for the walkthrough's service (one consumed event, one published event):

```text evidence="expected"
$ pso dispatch:graph
gw --orders.confirmed--> channel:orders.confirmed.demo62984
channel:orders.demo62984 --orders.placed--> gw

$ pso dispatch:events
orders.placed@1  channel orders.demo62984  gw consumes  schema yes  consumers: gw
orders.confirmed@1  channel orders.confirmed.demo62984  gw publishes  schema none  consumers: -

$ pso dispatch:consumers
orders.placed                gw  OrderPlacedConsumer  group gw  (src/dispatch/orders/orders.consumer.ts)
```

Read `dispatch:graph` as arrows: a publisher points at the channel it writes, a channel points at the consumers of each event type. With several services the graph shows who talks to whom without reading any code.

```bash
pso dispatch:graph --mermaid     # paste into any Mermaid renderer (documentation, pull requests)
pso dispatch:doctor              # opt-in live probe: connects, reads adapter health, disconnects
```

The live counters for a real run, and what each means, are in the [walkthrough](/dispatch/walkthrough).

## Common mistakes

- Reading the graph as live state: it is the *declared* topology.
- Treating a green `dispatch:doctor` as proof that events flow: it proves the connection only.
- Expecting lag or dead-letter depth in Studio: use your broker's tooling for those.

## Next steps

- [Walkthrough: publish, consume, retry, dead-letter](/dispatch/walkthrough)
- [Studio](/devops/studio)
