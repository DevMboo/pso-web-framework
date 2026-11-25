import type { ServiceDecl, WorkspaceConfig } from "@pso/core";

/**
 * Deployment descriptors for Kubernetes, AWS ECS (Fargate), Azure Container Apps and Google Cloud Run. They are GENERATED AND STATICALLY VALIDATED
 * here; nothing is ever applied to a real cloud account by PSO. Secrets are referenced (Secret / Secrets Manager / Key Vault / Secret Manager),
 * never written. Values that only you know are the literal `CHANGE_ME` so `pso deploy:validate` can tell you what is still open.
 */
export type DeployTarget = "kubernetes" | "ecs" | "container-apps" | "cloud-run";
export const DEPLOY_TARGETS: DeployTarget[] = ["kubernetes", "ecs", "container-apps", "cloud-run"];

const lines = (...l: string[]): string => l.join("\n") + "\n";
export const PLACEHOLDER = "CHANGE_ME";

export interface DeployOpts { registry: string; tag: string }
const isOrch = (s: ServiceDecl): boolean => s.role === "orchestrator";
const image = (s: ServiceDecl, o: DeployOpts): string => `${o.registry}/${s.name}:${o.tag}`;
/** Numeric uid of the non-root user the generated Dockerfile switches to (Kubernetes needs a numeric uid to verify runAsNonRoot). */
export const uidOf = (s: ServiceDecl): number => (s.runtime === "node" ? 1000 : 10001);
export const healthPath = (s: ServiceDecl): string => s.health ?? (s.runtime === "node" ? "/health/ready" : "/actuator/health");
const upper = (n: string): string => n.toUpperCase().replace(/-/g, "_");
const upstreams = (ws: WorkspaceConfig, s: ServiceDecl): Array<[string, string]> => (isOrch(s) ? ws.services.filter((x) => !isOrch(x)).map((x): [string, string] => [`PSO_UPSTREAM_${upper(x.name)}`, `${x.name}:${x.port}`]) : []);
const JWT = ["PSO_JWT_ISSUER", "PSO_JWT_AUDIENCE", "PSO_JWT_JWKS_URI"];

// ------------------------------------------------------------------ Kubernetes
export function kubernetes(ws: WorkspaceConfig, o: DeployOpts): Record<string, string> {
  const files: Record<string, string> = {};
  files["namespace.yaml"] = lines(
    "apiVersion: v1", "kind: Namespace", "metadata:", "  name: pso", "  labels:", "    pod-security.kubernetes.io/enforce: restricted", "---",
    "# Default deny; the orchestrator is the only workload allowed to reach the services, and only on their service ports.",
    "apiVersion: networking.k8s.io/v1", "kind: NetworkPolicy", "metadata:", "  name: default-deny", "  namespace: pso", "spec:", "  podSelector: {}", "  policyTypes: [Ingress]",
  );
  files["config.example.yaml"] = lines(
    "# Non-secret authentication settings. Fill in, then `kubectl apply -f`. Real secrets (keys, passwords) belong in a Secret created out of band.",
    "apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: pso-jwt", "  namespace: pso", "data:", ...JWT.map((k) => `  ${k}: ${PLACEHOLDER}`), "  PSO_JWT_ALGORITHMS: ES256",
  );
  for (const s of ws.services) {
    const labels = ["    app.kubernetes.io/name: " + s.name, "    app.kubernetes.io/part-of: pso"];
    files[`${s.name}.yaml`] = lines(
      "apiVersion: apps/v1", "kind: Deployment", "metadata:", `  name: ${s.name}`, "  namespace: pso", "  labels:", ...labels,
      "spec:", "  replicas: 2", "  revisionHistoryLimit: 3", "  selector:", "    matchLabels:", `      app.kubernetes.io/name: ${s.name}`,
      "  template:", "    metadata:", "      labels:", ...labels.map((l) => "  " + l),
      "    spec:", "      automountServiceAccountToken: false", "      securityContext:", "        runAsNonRoot: true", `        runAsUser: ${uidOf(s)}`, `        runAsGroup: ${uidOf(s)}`, "        seccompProfile:", "          type: RuntimeDefault",
      "      containers:", `        - name: ${s.name}`, `          image: ${image(s, o)}`, "          imagePullPolicy: IfNotPresent",
      "          ports:", `            - containerPort: ${s.port}`, "              name: http",
      "          env:", `            - { name: PORT, value: "${s.port}" }`, '            - { name: HOST, value: "0.0.0.0" }',
      ...upstreams(ws, s).map(([k, v]) => `            - { name: ${k}, value: "${v}" }`),
      ...JWT.map((k) => `            - { name: ${k}, valueFrom: { configMapKeyRef: { name: pso-jwt, key: ${k} } } }`),
      "          readinessProbe:", `            httpGet: { path: ${healthPath(s)}, port: http }`, "            periodSeconds: 10", "            failureThreshold: 6",
      "          livenessProbe:", `            httpGet: { path: ${healthPath(s)}, port: http }`, "            initialDelaySeconds: 30", "            periodSeconds: 20",
      "          resources:", "            requests: { cpu: 100m, memory: 256Mi }", "            limits: { cpu: \"1\", memory: 512Mi }",
      "          securityContext:", "            allowPrivilegeEscalation: false", "            readOnlyRootFilesystem: true", "            capabilities:", "              drop: [ALL]",
      "          volumeMounts:", "            - { name: tmp, mountPath: /tmp }",
      "      volumes:", "        - { name: tmp, emptyDir: { sizeLimit: 64Mi } }",
      "---", "apiVersion: v1", "kind: Service", "metadata:", `  name: ${s.name}`, "  namespace: pso", "spec:", "  type: ClusterIP", "  selector:", `    app.kubernetes.io/name: ${s.name}`,
      "  ports:", `    - { name: http, port: ${s.port}, targetPort: http }`,
      "---", "apiVersion: networking.k8s.io/v1", "kind: NetworkPolicy", "metadata:", `  name: allow-${isOrch(s) ? "ingress-to" : "orchestrator-to"}-${s.name}`, "  namespace: pso", "spec:",
      "  podSelector:", "    matchLabels:", `      app.kubernetes.io/name: ${s.name}`, "  policyTypes: [Ingress]", "  ingress:",
      isOrch(s) ? `    - ports: [{ port: ${s.port} }]  # put an Ingress/Gateway with TLS in front; this is the only entry point` : "    - from:\n        - podSelector:\n            matchLabels:\n              app.kubernetes.io/name: " + (ws.services.find(isOrch)?.name ?? "orchestrator") + `\n      ports: [{ port: ${s.port} }]`,
    );
  }
  return files;
}

// ------------------------------------------------------------------ AWS ECS (Fargate)
export function ecs(ws: WorkspaceConfig, o: DeployOpts): Record<string, string> {
  const files: Record<string, string> = {};
  for (const s of ws.services) {
    const secret = (k: string) => ({ name: k, valueFrom: `arn:aws:secretsmanager:${PLACEHOLDER}:${PLACEHOLDER}:secret:pso/${k}` });
    files[`${s.name}.taskdef.json`] = JSON.stringify({
      family: `pso-${s.name}`, requiresCompatibilities: ["FARGATE"], networkMode: "awsvpc", cpu: "512", memory: "1024",
      executionRoleArn: `arn:aws:iam::${PLACEHOLDER}:role/ecsTaskExecutionRole`, taskRoleArn: `arn:aws:iam::${PLACEHOLDER}:role/pso-${s.name}-task`,
      runtimePlatform: { operatingSystemFamily: "LINUX", cpuArchitecture: "X86_64" },
      containerDefinitions: [{
        name: s.name, image: image(s, o), essential: true, user: String(uidOf(s)), readonlyRootFilesystem: true, privileged: false,
        portMappings: [{ containerPort: s.port, protocol: "tcp" }],
        environment: [{ name: "PORT", value: String(s.port) }, { name: "HOST", value: "0.0.0.0" }, ...upstreams(ws, s).map(([k, v]) => ({ name: k, value: v.replace(/^([^:]+):/, "$1.pso.local:") }))],
        secrets: JWT.map(secret),
        healthCheck: { command: ["CMD-SHELL", `wget -qO- http://127.0.0.1:${s.port}${healthPath(s)} >/dev/null || curl -fsS http://127.0.0.1:${s.port}${healthPath(s)} >/dev/null || exit 1`], interval: 15, timeout: 5, retries: 5, startPeriod: 45 },
        logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": `/pso/${s.name}`, "awslogs-region": PLACEHOLDER, "awslogs-stream-prefix": "ecs" } },
        linuxParameters: { initProcessEnabled: true, capabilities: { drop: ["ALL"] } },
      }],
    }, null, 2) + "\n";
  }
  files["README.md"] = lines("# ECS (Fargate) task definitions", "", "Generated and statically validated only; nothing was registered in AWS.", "", "Register with `aws ecs register-task-definition --cli-input-json file://<service>.taskdef.json` after replacing every `CHANGE_ME`.",
    "Services other than the orchestrator should run with NO public load balancer; the orchestrator sits behind an ALB with TLS. Secrets come from AWS Secrets Manager via `valueFrom`; the task execution role needs `secretsmanager:GetSecretValue` on exactly those secrets.");
  return files;
}

// ------------------------------------------------------------------ Azure Container Apps
export function containerApps(ws: WorkspaceConfig, o: DeployOpts): Record<string, string> {
  const files: Record<string, string> = {};
  for (const s of ws.services) {
    files[`${s.name}.yaml`] = lines(
      "# az containerapp create --name " + s.name + " --resource-group " + PLACEHOLDER + " --yaml " + s.name + ".yaml",
      "type: Microsoft.App/containerApps", `name: ${s.name}`, `location: ${PLACEHOLDER}`, "properties:", `  managedEnvironmentId: /subscriptions/${PLACEHOLDER}/resourceGroups/${PLACEHOLDER}/providers/Microsoft.App/managedEnvironments/${PLACEHOLDER}`,
      "  configuration:", "    activeRevisionsMode: Single", "    ingress:", `      external: ${isOrch(s) ? "true" : "false"}`, `      targetPort: ${s.port}`, "      transport: auto", "      allowInsecure: false",
      "    secrets:", ...JWT.map((k) => `      - { name: ${k.toLowerCase().replace(/_/g, "-")}, keyVaultUrl: "https://${PLACEHOLDER}.vault.azure.net/secrets/${k.toLowerCase().replace(/_/g, "-")}", identity: system }`),
      "  template:", "    containers:", `      - name: ${s.name}`, `        image: ${image(s, o)}`, "        resources: { cpu: 0.5, memory: 1Gi }",
      "        env:", `          - { name: PORT, value: "${s.port}" }`, '          - { name: HOST, value: "0.0.0.0" }',
      ...upstreams(ws, s).map(([k, v]) => `          - { name: ${k}, value: "${v}" }`),
      ...JWT.map((k) => `          - { name: ${k}, secretRef: ${k.toLowerCase().replace(/_/g, "-")} }`),
      "        probes:", `          - { type: Readiness, httpGet: { path: ${healthPath(s)}, port: ${s.port} }, periodSeconds: 10, failureThreshold: 6 }`, `          - { type: Liveness, httpGet: { path: ${healthPath(s)}, port: ${s.port} }, initialDelaySeconds: 30, periodSeconds: 20 }`,
      "    scale: { minReplicas: 1, maxReplicas: 5 }",
    );
  }
  return files;
}

// ------------------------------------------------------------------ Google Cloud Run
export function cloudRun(ws: WorkspaceConfig, o: DeployOpts): Record<string, string> {
  const files: Record<string, string> = {};
  for (const s of ws.services) {
    files[`${s.name}.service.yaml`] = lines(
      "# gcloud run services replace " + s.name + ".service.yaml --region " + PLACEHOLDER,
      "apiVersion: serving.knative.dev/v1", "kind: Service", "metadata:", `  name: ${s.name}`, "  annotations:", `    run.googleapis.com/ingress: ${isOrch(s) ? "all" : "internal"}`,
      "spec:", "  template:", "    metadata:", "      annotations:", "        autoscaling.knative.dev/minScale: \"1\"", "        autoscaling.knative.dev/maxScale: \"5\"",
      "    spec:", "      containerConcurrency: 80", "      timeoutSeconds: 60", `      serviceAccountName: pso-${s.name}@${PLACEHOLDER}.iam.gserviceaccount.com`,
      "      containers:", `        - image: ${image(s, o)}`, "          ports:", `            - containerPort: ${s.port}`,
      "          env:", '            - { name: HOST, value: "0.0.0.0" }',
      ...upstreams(ws, s).map(([k, v]) => `            - { name: ${k}, value: "${v}" }`),
      ...JWT.map((k) => `            - { name: ${k}, valueFrom: { secretKeyRef: { name: ${k.toLowerCase().replace(/_/g, "-")}, key: latest } } }`),
      "          resources:", "            limits: { cpu: \"1\", memory: 512Mi }",
      "          startupProbe:", `            httpGet: { path: ${healthPath(s)} }`, "            periodSeconds: 5", "            failureThreshold: 24",
      "          livenessProbe:", `            httpGet: { path: ${healthPath(s)} }`, "            periodSeconds: 20",
    );
  }
  return files;
}

export function generate(target: DeployTarget, ws: WorkspaceConfig, o: DeployOpts): Record<string, string> {
  return target === "kubernetes" ? kubernetes(ws, o) : target === "ecs" ? ecs(ws, o) : target === "container-apps" ? containerApps(ws, o) : cloudRun(ws, o);
}

// ------------------------------------------------------------------ static validation
export interface Finding { file: string; level: "error" | "warning"; rule: string; message: string }

/** Policy checks over the descriptor text. They look at the files as they are on disk (including your edits), not at what was generated. */
export function checkDescriptor(target: DeployTarget, file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const err = (rule: string, message: string) => out.push({ file, level: "error", rule, message });
  const warn = (rule: string, message: string) => out.push({ file, level: "warning", rule, message });
  if (file.endsWith(".md")) return out;
  if (/:latest(\s|"|$)/m.test(text)) err("image-tag", "an image uses the mutable :latest tag; use an immutable version or digest");
  const inline = text.split("\n").some((l) => !/arn:aws:secretsmanager|valueFrom|secretKeyRef|secretRef|keyVaultUrl|CHANGE_ME/.test(l) && (/-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}/.test(l) || /\b(password|passwd|token|api[_-]?key|client[_-]?secret|secret[_-]?key)["']?\s*[:=]\s*["']?[A-Za-z0-9+/_-]{12,}/i.test(l)));
  if (inline) err("inline-secret", "a secret value appears to be written into the descriptor; reference a secret store instead");
  const placeholders = (text.match(/CHANGE_ME/g) ?? []).length;
  if (placeholders) warn("placeholder", `${placeholders} CHANGE_ME value(s) must be filled in before this can be deployed`);
  if (target === "kubernetes" && /kind:\s*Deployment/.test(text)) {
    if (!/runAsNonRoot:\s*true/.test(text)) err("run-as-non-root", "pod must set runAsNonRoot: true");
    if (!/readOnlyRootFilesystem:\s*true/.test(text)) err("read-only-rootfs", "container must set readOnlyRootFilesystem: true");
    if (!/allowPrivilegeEscalation:\s*false/.test(text)) err("no-privilege-escalation", "container must set allowPrivilegeEscalation: false");
    if (!/drop:\s*\[\s*ALL\s*\]/.test(text)) err("drop-capabilities", "container must drop ALL capabilities");
    if (!/seccompProfile/.test(text)) err("seccomp", "pod should use the RuntimeDefault seccomp profile");
    if (!/limits:/.test(text)) err("resource-limits", "container must declare resource limits");
    if (!/readinessProbe:/.test(text) || !/livenessProbe:/.test(text)) err("probes", "container needs readiness and liveness probes");
    if (/privileged:\s*true|hostNetwork:\s*true|hostPID:\s*true|hostPath:/.test(text)) err("host-access", "privileged containers, host namespaces and hostPath volumes are not allowed");
    if (/automountServiceAccountToken:\s*true/.test(text) || !/automountServiceAccountToken:\s*false/.test(text)) warn("service-account-token", "disable automountServiceAccountToken unless the workload calls the Kubernetes API");
  }
  if (target === "ecs" && file.endsWith(".json")) {
    let j: { containerDefinitions?: Array<Record<string, unknown>>; networkMode?: string };
    try { j = JSON.parse(text) as typeof j; } catch { err("parse", "not valid JSON"); return out; }
    for (const c of j.containerDefinitions ?? []) {
      if (c["readonlyRootFilesystem"] !== true) err("read-only-rootfs", `container ${String(c["name"])} must set readonlyRootFilesystem: true`);
      if (c["privileged"] === true) err("privileged", "privileged containers are not allowed");
      if (!c["user"] || c["user"] === "0" || c["user"] === "root") err("run-as-non-root", "container must run as a non-root user");
      if (!c["healthCheck"]) err("probes", "container needs a healthCheck");
      if (!c["logConfiguration"]) err("logging", "container needs a logConfiguration");
      for (const e of (c["environment"] as Array<{ name: string }> | undefined) ?? []) if (/SECRET|PASSWORD|TOKEN|KEY/i.test(e.name) && !/PUBLIC/i.test(e.name)) err("inline-secret", `environment ${e.name} looks like a secret; use "secrets" with valueFrom`);
    }
    if (j.networkMode !== "awsvpc") err("network-mode", "Fargate requires networkMode awsvpc");
  }
  if (target === "container-apps" && /allowInsecure:\s*true/.test(text)) err("tls", "ingress must not allow insecure (plain HTTP) traffic");
  if (target === "container-apps" && !/probes:/.test(text)) err("probes", "container needs probes");
  if (target === "cloud-run" && !/startupProbe:|livenessProbe:/.test(text)) err("probes", "container needs a startup or liveness probe");
  return out;
}
