import { cmp } from "./diagnostics.ts";

/** Deterministic cycle detection. Each cycle is a node path with the first node repeated at the end. */
export function findCycles(edges: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const stack: string[] = [];
  const visit = (n: string): void => {
    state.set(n, 1);
    stack.push(n);
    for (const m of [...(edges.get(n) ?? [])].sort(cmp)) {
      const s = state.get(m);
      if (s === 1) cycles.push([...stack.slice(stack.indexOf(m)), m]);
      else if (s === undefined && edges.has(m)) visit(m);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of [...edges.keys()].sort(cmp)) if (!state.has(n)) visit(n);
  return cycles;
}

/**
 * Dependency-first order (dependencies before dependents), ties broken alphabetically.
 * Throws on cycles or unknown nodes.
 */
export function topoOrder(edges: Map<string, string[]>): string[] {
  const cycles = findCycles(edges);
  if (cycles.length) throw new Error(`Cycle: ${cycles[0]!.join(" -> ")}`);
  const done = new Set<string>();
  const order: string[] = [];
  const visit = (n: string): void => {
    if (done.has(n)) return;
    done.add(n);
    for (const m of [...(edges.get(n) ?? [])].sort(cmp)) {
      if (!edges.has(m)) throw new Error(`Unknown node "${m}" required by "${n}"`);
      visit(m);
    }
    order.push(n);
  };
  for (const n of [...edges.keys()].sort(cmp)) visit(n);
  return order;
}
