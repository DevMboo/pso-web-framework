import { readFileSync } from "node:fs";
import { CloudError } from "@pso/deploy";
import { publicKeyRaw } from "@pso/frontend/node";
import { str } from "./args.ts";
import { cloudInstance } from "./commands-cloud.ts";
import { CliError } from "./fsx.ts";

/**
 * Keys for microfrontend release manifests. Two sources, never both:
 *   - a local signer of `pso signer:generate` (`--signer <name>`): the private key stays in this machine's protected credential store,
 *     and the key id is the signer's fingerprint, so the shell trusts it with `pso frontend:config --trust-signer <name>`;
 *   - an Ed25519 PEM key file with an explicit key id (`--sign-key <pem> --key-id <id>`).
 */
export type ReleaseSigning =
  | { kind: "none" }
  | { kind: "file"; keyId: string; privateKeyPem: string }
  | { kind: "signer"; name: string };

export function releaseSigningFromFlags(flags: Record<string, string | boolean | undefined>): ReleaseSigning {
  const signer = str(flags["signer"]), keyFile = str(flags["sign-key"]), keyId = str(flags["key-id"]);
  if (signer !== undefined && (keyFile !== undefined || keyId !== undefined)) throw new CliError("--signer and --sign-key/--key-id are two ways to give the signing key: use one", "A local signer (pso signer:list) keeps its private key in the credential store");
  if (signer !== undefined) return { kind: "signer", name: signer };
  if ((keyFile && !keyId) || (!keyFile && keyId)) throw new CliError("--sign-key and --key-id go together");
  return keyFile && keyId ? { kind: "file", keyId, privateKeyPem: readFileSync(keyFile, "utf8") } : { kind: "none" };
}

/** Runs `build` with the signing key (or without one). With a local signer the private key is read from the credential store for this call only. */
export function withReleaseKey<T>(s: ReleaseSigning, purpose: string, build: (signWith?: { keyId: string; privateKeyPem: string }) => T): T {
  if (s.kind === "none") return build();
  if (s.kind === "file") return build({ keyId: s.keyId, privateKeyPem: s.privateKeyPem });
  try {
    return cloudInstance().signWithSigner(s.name, purpose, (privateKeyPem, signer) => build({ keyId: signer.keyId, privateKeyPem }));
  } catch (e) {
    if (e instanceof CloudError) throw new CliError(e.message, e.hint ?? "pso signer:list");
    throw e;
  }
}

/** The trusted key of a local signer, in the form of the runtime configuration's `trustedKeys` (public part only). */
export function trustedKeyOfSigner(name: string): { keyId: string; publicKey: string } {
  const s = cloudInstance().signers().find((x) => x.name === name);
  if (!s) throw new CliError(`no signer named "${name}" on this machine`, "pso signer:list, or create one with pso signer:generate");
  return { keyId: s.keyId, publicKey: publicKeyRaw(s.publicKey) };
}
