import { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { buildGateway, type Gw } from "./gw-fixture.ts";
import { randomPort, startNode } from "./helpers.ts";

/** Shared by the channels end-to-end tests: a generated orchestrator with a recruitment module (channels, DTOs, DI, one HTTP action that publishes). */
const DTO_SUB = `import { Dto, Required, StringField } from "@pso/http";

@Dto()
export class CandidateSubscriptionDto {
  @Required() @StringField()
  candidateId!: string;
}
`;
const DTO_STATUS = `import { Dto, Required, OneOf } from "@pso/http";

@Dto()
export class UpdateStatusDto {
  @Required() @OneOf("APPLIED", "INTERVIEW", "HIRED", "REJECTED")
  status!: string;
}
`;
const DTO_UPDATED = `import { Dto, Required, StringField, OneOf } from "@pso/http";

@Dto()
export class CandidateUpdatedDto {
  @Required() @StringField()
  candidateId!: string;

  @Required() @OneOf("APPLIED", "INTERVIEW", "HIRED", "REJECTED")
  status!: string;
}
`;
const ACCESS = `import { Injectable } from "@pso/http";
import type { Principal } from "@pso/security";

/** The application's business rule: who may see which candidate (resource-level authorization). */
@Injectable()
export class CandidateAccess {
  private readonly owners: Record<string, string> = { c1: "alice", c2: "bob" };
  canRead(user: Principal | null, candidateId: string): boolean {
    return user !== null && (this.owners[candidateId] === user.subject || user.hasRole("recruiter"));
  }
}
`;
const CHANNELS = `import { Channel, OnConnect, OnSubscribe, OnEvent, OnDisconnect, Payload, Client, Context, ChannelParam } from "@pso/channels";
import type { ChannelClient, ChannelContext } from "@pso/channels";
import { Scopes } from "@pso/http";
import { CandidateAccess } from "./candidate-access";
import { CandidateSubscriptionDto } from "./dto/candidate-subscription.dto";
import { CandidateUpdatedDto } from "./dto/candidate-updated.dto";

@Channel("/recruitment", { visibility: "private" })
export class RecruitmentChannel {
  @OnSubscribe()
  @Scopes("recruitment:read")
  async authorize(@Context() context: ChannelContext): Promise<boolean> {
    return context.user !== null;
  }

  @OnEvent("candidate.subscribe")
  @Scopes("candidate:read")
  async subscribeCandidate(@Payload(CandidateSubscriptionDto) payload: CandidateSubscriptionDto, @Client() client: ChannelClient) {
    await client.join("candidate." + payload.candidateId);
    return { joined: payload.candidateId };
  }

  @OnDisconnect()
  async disconnect(@Client() client: ChannelClient): Promise<void> {
    console.log(JSON.stringify({ level: "info", msg: "recruitment client left", id: client.id.length > 0 }));
  }
}

@Channel("candidate.{candidateId}", { visibility: "private", publishers: ["recruitment-service"], events: { "candidate.updated": CandidateUpdatedDto } })
export class CandidateChannel {
  constructor(private readonly access: CandidateAccess) {}

  @OnSubscribe()
  @Scopes("candidate:read")
  async authorize(@ChannelParam("candidateId") candidateId: string, @Context() context: ChannelContext): Promise<boolean> {
    return this.access.canRead(context.user, candidateId);
  }
}

@Channel("ghost")
export class GhostChannel {
  @OnConnect()
  never(): boolean { return true; }
}
`;
const CONTROLLER = `import { Controller, RestController, Post, Body, Param } from "@pso/http";
import { ChannelPublisher } from "@pso/channels";
import { UpdateStatusDto } from "./dto/update-status.dto";

@Controller()
@RestController("/recruitment")
export class RecruitmentController {
  constructor(private readonly channels: ChannelPublisher) {}

  @Post("/candidates/:id/status")
  async update(@Param("id") id: string, @Body(UpdateStatusDto) body: UpdateStatusDto) {
    // ... the business change and its database transaction would be here ...
    const { eventId } = await this.channels.publish("candidate." + id, "candidate.updated", { candidateId: id, status: body.status }, {});
    return { updated: id, eventId };
  }
}
`;
const module_ = (channels: string) => `import { defineModule } from "@pso/core";
import routes from "./ROUTES.pso";
import { RecruitmentController } from "./recruitment.controller";
import { CandidateAccess } from "./candidate-access";
import { RecruitmentChannel, CandidateChannel, GhostChannel } from "./recruitment.channel";
void GhostChannel;

export default defineModule({ name: "recruitment", controllers: [RecruitmentController], providers: [CandidateAccess], channels: [${channels}], routes, imports: [], exports: [] });
`;
const ROUTES = `import { defineRoutes } from "@pso/http";
import { RecruitmentController } from "./recruitment.controller";

export default defineRoutes({
  routes: [
    { method: "POST", path: "/recruitment/candidates/:id/status", controller: RecruitmentController, action: "update", security: { guard: "jwt", scopes: ["candidate:write"] } },
  ],
});
`;

const gateways: Gw[] = [];
const toClean: string[] = [];
after(() => { for (const g of gateways) g.dispose(); for (const d of toClean) rmSync(d, { recursive: true, force: true }); });

export async function launch(channelsExport = "RecruitmentChannel, CandidateChannel", extraEnv: Record<string, string> = {}, existing?: { g: Gw; port: number; pub: string; keys: Awaited<ReturnType<typeof generateKeyPair>> }) {
  const keys = existing?.keys ?? await generateKeyPair("ES256", { extractable: true });
  const g = existing?.g ?? await buildGateway("pso-ch-", ({ gw }) => {
    const dir = join(gw, "src/routes/recruitment");
    mkdirSync(join(dir, "dto"), { recursive: true });
    writeFileSync(join(dir, "dto/candidate-subscription.dto.ts"), DTO_SUB);
    writeFileSync(join(dir, "dto/candidate-updated.dto.ts"), DTO_UPDATED);
    writeFileSync(join(dir, "dto/update-status.dto.ts"), DTO_STATUS);
    writeFileSync(join(dir, "candidate-access.ts"), ACCESS);
    writeFileSync(join(dir, "recruitment.channel.ts"), CHANNELS);
    writeFileSync(join(dir, "recruitment.controller.ts"), CONTROLLER);
    writeFileSync(join(dir, "MODULE.pso.ts"), module_(channelsExport));
    writeFileSync(join(dir, "ROUTES.pso.ts"), ROUTES);
  });
  if (!existing) gateways.push(g);
  const pub = existing?.pub ?? join(g.root, "ch-public.pem");
  if (!existing) writeFileSync(pub, await exportSPKI(keys.publicKey));
  const port = existing?.port ?? randomPort();
  const started = await startNode(g.gw, { PORT: String(port), PSO_JWT_ISSUER: "https://idp.test", PSO_JWT_AUDIENCE: "pso-api", PSO_JWT_PUBLIC_KEY_FILE: pub, PSO_JWT_ALGORITHMS: "ES256", PSO_DIAGNOSTICS_TOKEN: "diagnostics-token-0123456789abcdef", PSO_CHANNELS_AUTH_TIMEOUT_MS: "1500", PSO_CHANNELS_MAX_MESSAGE_BYTES: "2048", PSO_CHANNELS_HEARTBEAT_MS: "1000", PSO_CHANNELS_RATE_PER_SECOND: "50", PSO_CHANNELS_BURST: "60", ...extraEnv });
  const token = (sub: string, scope: string, roles: string[] = [], expSeconds = 1800) => new SignJWT({ scope, roles }).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer("https://idp.test").setAudience("pso-api").setSubject(sub).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds).sign(keys.privateKey);
  return { g, keys, pub, port, child: started.child, logs: started.logs, token, ws: `ws://127.0.0.1:${port}/channels`, http: (p: string) => `http://127.0.0.1:${port}${p}` };
}
export type Launched = Awaited<ReturnType<typeof launch>>;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const until = async (f: () => boolean, ms = 8000): Promise<void> => { for (let i = 0; i < ms / 25 && !f(); i++) await sleep(25); assert.ok(f(), "condition not reached in time"); };
export const connections = async (a: Launched): Promise<number> => { const r = await fetch(a.http("/_pso/telemetry"), { headers: { authorization: "Bearer diagnostics-token-0123456789abcdef" } }); return ((await r.json()) as { channels?: { connections: number } }).channels?.connections ?? -1; };
export const update = (a: Launched, tk: string, id: string, status: string) => fetch(a.http(`/recruitment/candidates/${id}/status`), { method: "POST", headers: { authorization: `Bearer ${tk}`, "content-type": "application/json", "x-correlation-id": "corr-ch-update-001" }, body: JSON.stringify({ status }) });
export const SCOPES = "recruitment:read candidate:read";

