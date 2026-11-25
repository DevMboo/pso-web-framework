import { defineFrontendRoutes } from "@pso/frontend";

// Routes are relative to the path the FEI mounts this microfrontend at (for example "/cart").
export default defineFrontendRoutes({
  routes: [
    { path: "/", page: "./src/pages/Home.tsx", title: "Cart" },
  ],
});
