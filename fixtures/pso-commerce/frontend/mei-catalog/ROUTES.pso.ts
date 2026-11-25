import { defineFrontendRoutes } from "@pso/frontend";

// Routes are relative to the path the FEI mounts this microfrontend at ("/catalog").
export default defineFrontendRoutes({
  routes: [
    { path: "/", page: "./src/pages/Products.tsx", title: "Catalog" },
    { path: "/new", page: "./src/pages/CreateProduct.tsx", title: "New product", scopes: ["catalog:write"] },
    { path: "/:id", page: "./src/pages/ProductDetails.tsx", title: "Product" },
  ],
});
