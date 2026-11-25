import { defineFrontendRoutes } from "@pso/frontend";

// Routes are relative to the path the FEI mounts this microfrontend at ("/orders").
export default defineFrontendRoutes({
  routes: [
    { path: "/", page: "./src/pages/Orders.tsx", title: "Orders" },
    { path: "/new", page: "./src/pages/PlaceOrder.tsx", title: "Place an order", scopes: ["orders:write"] },
    { path: "/:id", page: "./src/pages/OrderDetails.tsx", title: "Order" },
  ],
});
