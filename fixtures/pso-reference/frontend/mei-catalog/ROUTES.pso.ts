import { defineFrontendRoutes } from "@pso/frontend";

// Routes are relative to the path the FEI mounts this microfrontend at (for example "/catalog").
export default defineFrontendRoutes({
  routes: [
    { path: "/", page: "./src/pages/Home.tsx", title: "Catalog" },
  ],
});
