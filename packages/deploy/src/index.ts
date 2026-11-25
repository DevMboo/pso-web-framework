/**
 * @pso/deploy - Cloud Lifecycle & Operations for PSO Web.
 *
 * Public surface: the declaration API (`defineDeployment`, `definePipeline`) that projects import, and the operational facade
 * (`Cloud`) that the CLI and Studio share. The agent (a separate bundled file, see agent/) and its engine run on the target server.
 */
export { defineDeployment, definePipeline, validateDeployment, validatePipeline, servicesOf, DEFAULT_PIPELINE, declarationHash } from "./declare.ts";
export type { DeploymentDecl, PipelineDecl, ServiceDecl, StageDecl, StageType, StrategyType, StrategyDecl, SourceDecl, GitSource, ArtifactSource, NginxDecl, MigrationDecl, DeclDiagnostic } from "./declare.ts";
export { loadDeclarationFile, parseDeclaration } from "./static-load.ts";
export { Cloud, discoverDeclarations, declFor, safe } from "./cloud.ts";
export type { DeclarationFile, AddConnectionSpec, TestStep } from "./cloud.ts";
export { AgentClient, CloudError, StdioTransport, READ_ONLY_OPS } from "./client.ts";
export type { Transport } from "./client.ts";
export { LocalStore, describeConnection } from "./local-state.ts";
export type { ConnectionRecord, AuthKind } from "./local-state.ts";
export { resolveCredentialProvider, MemoryCredentialProvider, EncryptedFileProvider, CredentialStoreError } from "./credentials.ts";
export type { CredentialProvider } from "./credentials.ts";
export { redactText, redactValue, registerSecret, looksSecret } from "./redact.ts";
export { OPERATIONS, ROLES, PROTOCOL_VERSIONS, AGENT_VERSION } from "./protocol.ts";
export type { Role } from "./protocol.ts";
export { buildPlan, MANDATORY_INVARIANTS } from "./agent/plan.ts";
export type { Plan } from "./agent/plan.ts";
export { renderConfig as renderNginxConfig, isManaged as isNginxManaged } from "./agent/nginx.ts";
export { AgentServer } from "./agent/server.ts";
export { Engine } from "./agent/engine.ts";
export type { Deployment, DeployState } from "./agent/engine.ts";
export { AgentState } from "./agent/state.ts";
export { scanHostKey, sshBaseArgs, askpassEnv, sshExec, openTunnel } from "./ssh.ts";
export type { SshContext, Tunnel } from "./ssh.ts";
export { probeHttps, resolveUrls, runTest, isMutating } from "./access.ts";
export { classifySudoList, assessExposure, lintNginx, parseNginx } from "./agent/visibility.ts";
export { generateSigner, signManifest, verifySigned, treeDigest, describeProvenance } from "./signing.ts";
export type { ReleaseManifest, SignedManifest, TrustedSigner, Provenance } from "./signing.ts";
export type { SignerRecord } from "./local-state.ts";
export { inspectKeyFile, repairKeyFile, explainSshFailure, parseIcacls, type KeyAccess, type RepairResult, type KeyVerdict } from "./keyaccess.ts";
