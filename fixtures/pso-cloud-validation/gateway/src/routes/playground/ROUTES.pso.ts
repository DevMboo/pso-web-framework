import { defineRoutes } from "@pso/http";
import { PlaygroundController } from "./playground.controller";

// The Commerce web playground (fixtures/pso-commerce/web) is served by this gateway so that the page, the API and the WebSocket share ONE origin.
// The page and its assets carry no data and no credential, so they are public; every API call the page makes needs a bearer token.
export default defineRoutes({
  routes: [
    { method: "GET", path: "/playground", controller: PlaygroundController, action: "index", security: { public: true }, metadata: { service: "playground" } },
    { method: "GET", path: "/playground/:asset", controller: PlaygroundController, action: "asset", security: { public: true }, metadata: { service: "playground" } }
  ]
});
