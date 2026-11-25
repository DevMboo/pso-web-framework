import type { Guard } from "@pso/http";

// Module-local guard: its name ("users-key") is the file name without ".guard.ts".
const guard: Guard = (req) => (req.headers["x-key"] === "k" ? true : { allow: false, status: 401 });
export default guard;
