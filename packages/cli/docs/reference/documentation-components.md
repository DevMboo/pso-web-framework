---
title: Documentation components
description: The one component for each kind of representation in this documentation (file tree, architecture, flow, terminal command, output, source, callout, table), its canonical syntax, and the rules that keep hand-drawn diagrams out.
order: 9
status: stable
keywords: [documentation, components, tree, architecture, flow, diagram, code block, callout, table, contributing]
related: [reference/extending, getting-started/introduction, frontend/overview, tutorials/first-application]
---
Every representation in this documentation has one component. A page never draws a tree or a diagram with characters, never positions arrows by hand and never invents its own formatting: the portal renders each component with the same frame, icons, spacing, themes and keyboard behavior, and a test fails when a page does it by hand. If you write documentation, or an assistant writes it for you, pick the component from this table.

| You are showing | Use | Fence |
|---|---|---|
| Files and folders | File tree | `tree` fence |
| Which components exist and who talks to whom | Architecture | `architecture` fence |
| An ordered path: a request, a start order, a failure sequence | Flow | `flow` fence |
| Commands to type | Terminal block | `bash` or `powershell` fence |
| What a program printed | Output block | `text` fence (with `evidence=`) |
| Source code and configuration | Source block | the language: `typescript`, `java`, `yaml`, `json`, `xml`, `sql`, `http`... |
| A named, interactive diagram that the portal ships | Built-in diagram | `:::diagram name="lifecycle"` |
| A warning, tip, note or status | Callout | `> [!WARNING]`, `> [!NOTE]`, `> [!TIP]`, `> [!STATUS]` |
| Things compared or looked up | Table | a GitHub-style Markdown table |

Choose by meaning, not by looks. A communication path is not a folder structure, so it never goes in a `tree`; a list of files is not a flow.

## File tree

Indent with two spaces; a trailing `/` marks a folder; `# text` adds a note; `# generated: text`, `manual`, `optional`, `env` or `changed` adds a badge. Icons follow the file type.

~~~markdown
```tree title="Site root of one domain on the server"
sites/commerce/
  fei/
    current.json # the active shell
  pso-runtime-config.json # manual: remotes and trusted keys
```
~~~

```tree title="Site root of one domain on the server"
sites/commerce/
  fei/
    current.json # the active shell
  pso-runtime-config.json # manual: remotes and trusted keys
```

## Architecture

A connected hierarchy of components. Indent with two spaces: a child is something its parent calls or contains. `Name (kind)` picks the icon: `client`, `shell`, `microfrontend`, `library`, `proxy`, `orchestrator`, `service`, `database`, `broker`, `security` (default `service`). After `#`, the text before ` | ` labels the connection from the parent (it is drawn on the connector); the text after it describes the component. A note alone is a description; a label alone ends with ` |`. Backticks in a note are code. Several top-level nodes are allowed.

~~~markdown
```architecture title="Request path of a PSO workspace"
internet (client)
  gateway (orchestrator) # HTTPS | ROUTES.pso.ts decides what is reachable
    catalog (service) # forwards, token checked again | owns the data
    billing (service) # forwards |
```
~~~

```architecture title="Request path of a PSO workspace"
internet (client)
  gateway (orchestrator) # HTTPS | ROUTES.pso.ts decides what is reachable
    catalog (service) # forwards, token checked again | owns the data
    billing (service) # forwards |
```

## Flow

Ordered paths, one per line. Separate steps with `->`; give a step a second line with ` | `; name a path with `[name]` at the start of the line; add a note with `# text` at the end. A line that starts with `->` continues the previous path. Steps wrap on narrow screens and are exposed as an ordered list.

~~~markdown
```flow title="The failure the outbox removes"
[1] save order | OK (committed)
[2] publish event | process crashes -> the order exists, the event never does # why the outbox exists
```
~~~

```flow title="The failure the outbox removes"
[1] save order | OK (committed)
[2] publish event | process crashes -> the order exists, the event never does # why the outbox exists
```

## Terminal, output and source

Commands go in `bash` or `powershell` blocks (a prompt is drawn for you; do not type `$`). Program output goes in `text` blocks and is labelled with `evidence="verified"`, `"expected"` or `"illustrative"`. Source code and configuration use their language so they are highlighted. A transcript that mixes a command and its output starts its lines with `$ ` and may contain the program's own arrows or drawing characters; that is the program's output, not a diagram.

## What the checks reject

`docs-rendering.test.ts` fails the documentation build when a block that is not source code (`text`, no language, `output`) contains drawing characters, an ASCII box, an indented list of paths or arrows drawn in text, when a `diagram` fence is used, and when prose contains an escaped backtick, a visible entity or an escaped Markdown character. It also checks the generated site for literal backticks in descriptions, double-escaped entities, tables whose rows have different widths, unrendered directives and ASCII boxes. Real source code is never touched by these rules. A `diagram` fence is a build error with the list of components to use instead.

## Limits and common mistakes

- The syntax is deliberately small. The architecture component draws a hierarchy: a component called by two parents appears twice, and a loop cannot be drawn. Use a flow, or the built-in interactive diagrams, for those.
- Do not use a tree for a request path or an architecture for a folder layout; the icons and the accessible roles would say the wrong thing.
- Do not paste a terminal diagram or an ASCII drawing from another tool: the build refuses it. Rewrite it with the component that matches its meaning and keep every relationship and label.
- A note is plain text with optional code spans; it is never HTML, and angle brackets are escaped for you.
- Fences that show this syntax use tildes (~~~) so the example can contain backtick fences.
