import type { Ctx } from "./commands.ts";

/** `--json` was given: print machine-readable output. Kept free of command imports so the maintenance entry point can use it. */
export const json = (ctx: Ctx) => ctx.flags["json"] === true;
export const emit = (ctx: Ctx, data: unknown, text: string) => ctx.print(json(ctx) ? JSON.stringify(data, null, 2) : text);
