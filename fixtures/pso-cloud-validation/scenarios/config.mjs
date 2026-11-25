// Where things are, and which server the scenarios target. Nothing here is a secret; the SSH key stays on the operator's machine.
import { resolve } from "node:path";
export const WORKSPACE = resolve(import.meta.dirname, "..").replaceAll("\\", "/");
export const FRAMEWORK = resolve(WORKSPACE, "..", "..").replaceAll("\\", "/");
/** The server under test: `ECV_HOST` (its public IP), `ECV_SSH_USER`, `ECV_SSH_KEY` (path of the private key, never copied into the repository). */
export const HOST = process.env.ECV_HOST ?? "<set ECV_HOST>";
export const SSH_USER = process.env.ECV_SSH_USER ?? "<set ECV_SSH_USER>";
export const SSH_KEY = process.env.ECV_SSH_KEY ?? "<set ECV_SSH_KEY>";
