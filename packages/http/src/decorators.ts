import "reflect-metadata";
import type { ParamSpec } from "./validation.ts";

export const K = {
  controller: "pso:controller", prefix: "pso:prefix", routes: "pso:routes", params: "pso:params",
  pub: "pso:public", guards: "pso:guards", scopes: "pso:scopes", roles: "pso:roles", injectable: "pso:injectable",
} as const;

export interface HttpBinding { action: string; method: string; path: string }
export interface ParamBinding { index: number; kind: "param" | "query" | "body" | "req" | "res" | "principal"; name?: string; /** DTO class for a validated body (`@Body(Dto)`) */ dto?: unknown; /** explicit conversion and constraints for a path or query value */ spec?: ParamSpec }

type AnyClass = abstract new (...args: never[]) => unknown;
type Target = object;

/** Marks a class as a controller. This alone never exposes anything: ROUTES.pso.ts decides. */
export function Controller(): (target: AnyClass) => void {
  return (target) => Reflect.defineMetadata(K.controller, true, target);
}
/** Path prefix of every action of the controller. */
export function RestController(prefix = "/"): (target: AnyClass) => void {
  return (target) => Reflect.defineMetadata(K.prefix, prefix, target);
}
/** Lets the dependency container construct a provider that has constructor dependencies. */
export function Injectable(): (target: AnyClass) => void {
  return (target) => Reflect.defineMetadata(K.injectable, true, target);
}

const http = (method: string) => (path = "/") => (target: Target, key: string | symbol): void => {
  const ctor = (target as { constructor: Function }).constructor;
  const list = (Reflect.getOwnMetadata(K.routes, ctor) as HttpBinding[] | undefined) ?? [];
  Reflect.defineMetadata(K.routes, [...list, { action: String(key), method, path }], ctor);
};
export const Get = http("GET");
export const Post = http("POST");
export const Put = http("PUT");
export const Patch = http("PATCH");
export const Delete = http("DELETE");

const param = (kind: ParamBinding["kind"]) => (name?: string, extra: { dto?: unknown; spec?: ParamSpec } = {}) => (target: Target, key: string | symbol | undefined, index: number): void => {
  if (key === undefined) return;
  const list = (Reflect.getOwnMetadata(K.params, target, key) as ParamBinding[] | undefined) ?? [];
  Reflect.defineMetadata(K.params, [...list, { index, kind, ...(name ? { name } : {}), ...(extra.dto ? { dto: extra.dto } : {}), ...(extra.spec ? { spec: extra.spec } : {}) }], target, key);
};
/** `@Param("id")` passes the raw string; `@Param("id", { type: "integer", min: 1 })` converts and checks it (a violation is a 400 problem). */
export const Param = (name: string, spec?: ParamSpec) => param("param")(name, spec ? { spec } : {});
export const Query = (name: string, spec?: ParamSpec) => param("query")(name, spec ? { spec } : {});
/** `@Body()` passes the parsed JSON untouched. `@Body(MyDto)` validates it against the @Dto class first; the action only runs when it is valid. */
export const Body = (dto?: abstract new (...args: never[]) => unknown) => param("body")(undefined, dto ? { dto } : {});
export const Req = () => param("req")();
export const Res = () => param("res")();

/** Security metadata may sit on a class or a method; it can add requirements but a route declaration can never be weakened by it. */
const meta = <T>(k: string, value: T) => (target: Target | AnyClass, key?: string | symbol): void => {
  if (key === undefined) Reflect.defineMetadata(k, value, target);
  else Reflect.defineMetadata(k, value, target, key);
};
export const Public = () => meta(K.pub, true);
export const UseGuards = (...names: string[]) => meta(K.guards, names);
export const Scopes = (...scopes: string[]) => meta(K.scopes, scopes);

export const readMeta = <T>(k: string, target: object, key?: string): T | undefined =>
  (key === undefined ? Reflect.getOwnMetadata(k, target) : Reflect.getOwnMetadata(k, target, key)) as T | undefined;
