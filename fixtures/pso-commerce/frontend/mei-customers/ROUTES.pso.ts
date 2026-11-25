import { defineFrontendRoutes } from "@pso/frontend";

// Routes are relative to the path the FEI mounts this microfrontend at ("/customers").
export default defineFrontendRoutes({
  routes: [
    { path: "/", page: "./src/pages/Customers.tsx", title: "Customers" },
    { path: "/new", page: "./src/pages/CreateCustomer.tsx", title: "New customer", scopes: ["customers:write"] },
    { path: "/:id", page: "./src/pages/CustomerDetails.tsx", title: "Customer" },
  ],
});
