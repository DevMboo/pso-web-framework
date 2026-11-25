---
title: Styling, isolation and performance
description: How Tailwind CSS, shared design tokens and cascade layers keep independently built microfrontends visually coherent without style collisions, and the performance measures PSO takes and reports.
order: 6
status: implemented
keywords: [tailwind, css layers, design tokens, preflight, style isolation, dark mode, performance, bundle size, lazy loading, caching]
related: [frontend/overview, frontend/releases, frontend/troubleshooting]
---
> [!STATUS]
> **Implemented and measured** on one development machine over loopback (Chrome, one run each). The numbers below are **measurements of the Commerce fixture**, not guarantees: compression, network latency and cache state of your deployment differ.

## One reset, shared tokens, layers

Tailwind 4 ships a CSS reset (Preflight). If every microfrontend loaded it, each would restyle the shell. PSO's strategy:

- The **shell** loads Preflight once and sets the values of the design tokens (`--pso-bg`, `--pso-surface`, `--pso-fg`, `--pso-brand`, radii, font) for light and dark themes (`data-theme` on the document).
- A **microfrontend** imports `@pso/frontend-react/tokens.css` (the token names only, mapped to Tailwind colors such as `bg-surface`, `text-muted`, `border-line`) and the Tailwind **utilities** layer. It never loads a reset and never selects bare elements.
- Everything sits in cascade layers (`theme`, `base`, `components`, `utilities`) so utilities always win over base styles and order does not depend on which bundle loaded first.
- Domain-specific CSS goes in CSS Modules or under `[data-pso-mei="<name>"]`, an attribute the generated module puts on its root.

Utilities are idempotent (`flex` means the same thing in every bundle), so duplicated utility rules across microfrontends are harmless. Tailwind **prefixes** were considered and not used by default: they make markup noisy and are unnecessary once the reset is single and selectors are limited to utilities; a team that needs one can add it in its own stylesheet. Teams share the **tokens**, not a component library: each MEI owns its components, and the fixture's three MEIs deliberately carry their own small copy of a UI kit.

## Accessibility defaults

The generated shell has a skip link, landmarks, keyboard-operable navigation with visible focus, `aria-live` notifications, loading states with `role="status"`, and errors with `role="alert"`; it honors `prefers-reduced-motion` and `prefers-color-scheme`. The Studio view of the frontend was checked with axe (WCAG 2 A and AA) with no violations; the generated shell was exercised in a real browser but has not been through a full accessibility audit.

## Performance measures

| Measure | How it is done |
|---|---|
| Lazy loading | each microfrontend loads on first navigation; `loading: "eager"` is opt-in; nothing is preloaded at start |
| Code splitting | page chunks per route; the MEI's `React` is shared, not downloaded again |
| Hashed, immutable assets | `[contenthash]` file names; `Cache-Control: immutable` for versioned files, `no-store` for pointers and the runtime configuration |
| Prefetch | hovering or focusing a navigation entry prefetches that microfrontend only if the user may open it, and not when `Save-Data` is on or the connection is 2G |
| Request deduplication | opt-in per GET (`dedupe: true`) |
| Subscriptions | one connection, reference-counted channels, released on navigation |
| Budgets | `budgets: { shellKb }` in `FEI.pso.ts` fails `pso frontend:build` when the gzip size is exceeded |

## Measurements (Commerce fixture, production build, loopback, one run)

| What | Result |
|---|---|
| FEI build output, gzip (all JS and CSS) | 171 KB |
| First load of the shell (JS and CSS, 7 requests, served uncompressed) | 560 KB |
| First navigation to a microfrontend (7 requests, uncompressed) | 141 KB, 147 ms to render |
| Second microfrontend | 167 ms |
| Repeat visit | 3 of 3 JS and CSS files from the browser cache |
| Cold load to the sign-in page | 336 ms |
| Create a customer / place an order through the SSH tunnel to Azure | 168 ms / 170 ms |
| Order confirmed after placement (asynchronous, observed in the page) | about 2.5 s |

A MEI's build output (about 210 KB gzip) is larger than what a browser downloads, because it includes a fallback copy of React that is fetched only if the shell does not provide a compatible one. These figures were taken without compression and without a CDN. No claim is made that this is faster than another architecture: it was not compared.

## Measured on the deployed Commerce frontend (real nginx with gzip, real Keycloak login, Chrome, loopback, one run)

| Measure | Result |
|---|---|
| Cold load to the sign-in page | 7 requests (2 JavaScript, 1 CSS), 179 KB transferred, about 145 ms |
| First microfrontend after sign-in (callback, token exchange, microfrontend, cold) | 15 requests, 52 KB, about 360 ms including the provider round trip |
| Second and third microfrontend, cold | about 110 ms, 9 requests, 50 KB |
| Navigation between microfrontends already loaded | median 28 ms, p95 38 ms over 120 navigations, no JavaScript request |
| Repeated navigation, resources | DOM nodes 244 to 246, JS event listeners 172 to 170, heap +0.5 MB after 120 navigations |
| Warm reload | 20 requests, 10 KB transferred, 4 served from the browser cache |
| React DOM | in one script (the shell's); no microfrontend carries its own copy |
| Layout shift, long tasks | 0.001, none |
| Build output, gzip | shell 168.5 KB JS + 4.2 KB CSS; microfrontends about 212 KB JS + 2 KB CSS each (a fallback React copy that the browser does not download) |

Methodology: Chrome DevTools Protocol counters after a forced garbage collection. An earlier run seemed to show DOM nodes and listeners growing with every navigation; the cause was the measuring tool (Playwright element handles from `waitForSelector` keep elements alive), not the application, and disappeared with `locator().waitFor()`. No comparison with another architecture was made, so no improvement is claimed.

## CSS isolation, checked in a browser

Preflight (the global reset) is present once, in the shell's stylesheet. Microfrontend stylesheets (6 to 7 KB each) declare no global element selectors (`body`, `html`, `*`, `h1`, `a`, `button`). Loading all three microfrontends leaves the shell's computed styles unchanged. Headings are identical across microfrontends. Switching the theme in the shell changes the shell and the microfrontend content through shared custom properties and survives a reload. axe-core (WCAG 2 A and AA) found no violations on Customers, Catalog and Orders in light and dark themes, there is no horizontal overflow at 390, 768 and 1280 px, and the interface uses SVG icons and no emoji. Limits: CSS is not sandboxed. A microfrontend that ships a global rule would affect everything, which is why the generated CSS is checked for global selectors in the evidence run; utility class names are shared by design, and a microfrontend that adds its own unscoped class can still collide with another.

## Limits and common mistakes

- Importing `tailwindcss` (the full bundle) in a MEI re-introduces the reset; import `tailwind/theme` and `utilities` as the template does.
- A global selector in a MEI (`button { ... }`) affects the whole page; the framework cannot prevent it, only the template's conventions and review do.
- The shell reload is not triggered by a MEI release: a browser that already loaded the old release keeps it until the page reloads.
