import { COMMANDS, type Command } from "./commands.ts";
import { SERVICE_COMMANDS } from "./commands-services.ts";
import { CONFIG_COMMANDS } from "./commands-config.ts";
import { SECURITY_COMMANDS } from "./commands-security.ts";
import { RESOURCE_COMMANDS } from "./commands-resource.ts";
import { DEVOPS_COMMANDS } from "./commands-devops.ts";
import { STUDIO_COMMANDS } from "./commands-studio.ts";
import { JAVA_COMMANDS } from "./commands-java.ts";
import { DISPATCH_COMMANDS } from "./commands-dispatch.ts";
import { DB_COMMANDS } from "./commands-db.ts";
import { HTTP_COMMANDS } from "./commands-http.ts";
import { STRUCTURE_COMMANDS } from "./commands-structure.ts";
import { AI_COMMANDS } from "./commands-ai.ts";
import { DIST_COMMANDS } from "./commands-dist.ts";
import { INSTALL_COMMANDS } from "./commands-install.ts";
import { DEPLOY_COMMANDS } from "./commands-deploy.ts";
import { STORAGE_COMMANDS } from "./commands-storage.ts";
import { CHANNEL_COMMANDS } from "./commands-channels.ts";
import { INTEGRATION_COMMANDS } from "./commands-integrations.ts";
import { TLS_COMMANDS } from "./commands-tls.ts";
import { MIGRATE_COMMANDS } from "./commands-migrate.ts";
import { MAKE_COMMANDS } from "./commands-make.ts";
import { TYPES_COMMANDS } from "./commands-types.ts";
import { IDP_COMMANDS } from "./commands-idp.ts";
import { CLOUD_COMMANDS } from "./commands-cloud.ts";
import { FRONTEND_COMMANDS } from "./commands-frontend.ts";
import { FRONTEND_RELEASE_COMMANDS } from "./commands-frontend-release.ts";
import { INFRA_COMMANDS } from "./commands-infra.ts";
import { DOCKER_COMMANDS } from "./commands-docker.ts";
import { MIGRATE_WORKSPACE_COMMANDS } from "./commands-workspace-migrate.ts";
import { HOST_COMMANDS } from "./commands-host.ts";

/**
 * How many positional arguments each command takes after its name. A command that is missing here fails the CLI's own tests: an
 * extra word on the command line is a mistake to report, never something to ignore.
 */
export const MAX_ARGS: Readonly<Record<string, number>> = {
  "ai:context": 0, "ai:init": 0, "build": 0, "channels:contracts": 0, "channels:enable": 0, "channels:validate": 0, "config:list": 0, "config:show": 0,
  "config:validate": 0, "create": 2, "database:enable": 1, "deploy": 0, "deploy:init": 0, "deploy:plan": 0, "deploy:validate": 0, "dev": 0, "dev:env": 0,
  "dispatch:consumers": 0, "dispatch:doctor": 0, "dispatch:events": 0, "dispatch:graph": 0, "dispatch:inspect": 0, "dispatch:install": 1, "dispatch:lock": 0,
  "dispatch:outbox": 0, "dispatch:providers": 0, "dispatch:remove": 0, "dispatch:validate": 0, "dist": 2, "docker:build": 0, "docker:init": 0, "docs": 0,
  "doctor": 0, "graph": 0, "init": 0, "inspect": 0, "install:react": 1, "integrity": 1, "java:install": 0, "lint": 0,
  "make:adapter": 1, "make:channel": 2, "make:config": 1, "make:contract": 2, "make:controller": 2, "make:dto": 2, "make:event": 1, "make:files": 1,
  "make:filter": 1, "make:guard": 2, "make:hook": 1, "make:listener": 1, "make:mapper": 2, "make:interceptor": 1, "make:decorator": 1, "make:entity": 1, "make:exception": 1, "make:client": 1, "make:request": 1, "make:response": 1, "make:crud": 1, "crud:bind": 1, "structure:inspect": 0, "make:middleware": 1, "make:migration": 1, "make:module": 1,
  "make:notifier": 1, "make:port": 1, "make:provider": 1, "make:repository": 1, "make:resource": 1, "make:route": 2, "make:service": 2,
  "make:dispatch-event": 1, "make:dispatch-handler": 1,
  "migrate": 0, "repair": 0, "rollback": 0, "routes:inspect": 1, "routes:list": 0, "security:audit": 0, "security:check": 0, "security:keys": 0,
  "security:policy": 0, "security:rotate": 0, "security:validate": 0, "services:graph": 0, "services:health": 0, "services:inspect": 1, "services:list": 0,
  "services:register": 1, "services:unregister": 1, "setup": 0, "storage:enable": 1, "storage:validate": 0, "studio": 0, "test": 0,
  "tls:check": 0, "tls:init": 0, "uninstall": 0, "types": 0, "update": 1, "validate": 0, "idp:dev": 1,
  "connection:add": 1, "connection:list": 0, "connection:test": 1, "connection:key": 1, "connection:rotate": 1, "connection:revoke": 1, "connection:remove": 1, "connection:tunnel": 1,
  "agent:install": 1, "agent:enroll": 1, "agent:status": 1, "agent:upgrade": 1, "agent:releases": 1, "agent:rollback": 1, "agent:uninstall": 1,
  "environment:add": 1, "environment:list": 0, "environment:inspect": 1, "environment:plan": 1, "environment:provision": 1, "environment:secret": 2, "environment:policy": 1, "environment:access": 1,
  "pipeline:validate": 1, "release:plan": 1, "release:approve": 1, "release:deploy": 1, "release:status": 1, "release:history": 1, "release:cancel": 1, "release:rollback": 1,
  "release:recover": 1, "release:logs": 1, "release:service": 3, "release:audit": 1,
  "release:url": 1, "release:endpoints": 1, "environment:network": 1, "environment:privileges": 1, "release:nginx": 1, "release:config": 1,
  "fei:register": 1, "fei:unregister": 1, "frontend:validate": 0, "frontend:inspect": 1, "frontend:routes": 0, "frontend:graph": 0, "frontend:install": 1, "frontend:make": 2, "frontend:dev": 0, "frontend:build": 1,
  "frontend:publish": 1, "frontend:rollback": 1, "frontend:releases": 1, "frontend:config": 0, "frontend:nginx": 0, "frontend:contracts": 0, "frontend:declare": 1,
  "infra:init": 0, "infra:plan": 0, "infra:apply": 0, "infra:repair": 0, "infra:rotate": 1, "infra:validate": 0, "infra:inspect": 1, "infra:status": 0, "infra:hosts": 0, "infra:token": 0, "infra:identity": 0,
  "docker:plan": 0, "docker:up": 0, "docker:down": 0, "docker:restart": 20, "docker:ps": 0, "docker:logs": 1, "docker:inspect": 1, "workspace:migrate": 0, "host:inspect": 1, "host:check": 0, "deploy:status": 0, "deploy:logs": 1, "deploy:unlock": 0,
  "signer:generate": 1, "signer:list": 0, "signer:remove": 1, "release:sign": 1, "release:verify": 1, "trust:list": 1, "trust:add": 1, "trust:revoke": 2,
};

/** Every implemented command. Add new command modules here. */
export const ALL_COMMANDS: Record<string, Command> = { ...TLS_COMMANDS, ...MIGRATE_COMMANDS, ...COMMANDS, ...MAKE_COMMANDS, ...TYPES_COMMANDS, ...IDP_COMMANDS, ...SERVICE_COMMANDS, ...CONFIG_COMMANDS, ...SECURITY_COMMANDS, ...RESOURCE_COMMANDS, ...DEVOPS_COMMANDS, ...STUDIO_COMMANDS, ...DB_COMMANDS, ...HTTP_COMMANDS, ...AI_COMMANDS, ...DIST_COMMANDS, ...INSTALL_COMMANDS, ...DEPLOY_COMMANDS, ...JAVA_COMMANDS, ...DISPATCH_COMMANDS, ...STORAGE_COMMANDS, ...CHANNEL_COMMANDS, ...INTEGRATION_COMMANDS, ...CLOUD_COMMANDS, ...FRONTEND_COMMANDS, ...FRONTEND_RELEASE_COMMANDS, ...INFRA_COMMANDS, ...DOCKER_COMMANDS, ...MIGRATE_WORKSPACE_COMMANDS, ...HOST_COMMANDS, ...STRUCTURE_COMMANDS };
for (const [name, cmd] of Object.entries(ALL_COMMANDS)) if (cmd.args === undefined && MAX_ARGS[name] !== undefined) cmd.args = MAX_ARGS[name]!;
