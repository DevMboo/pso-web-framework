import { defineFrontendRoutes } from "@pso/frontend";

// Routes the SHELL itself owns. Every microfrontend owns the routes under its own mount path (see FEI.pso.ts).
export default defineFrontendRoutes({
  routes: [
    { path: "/", page: "./src/pages/Home.tsx", title: "Home" },
  ],
});
