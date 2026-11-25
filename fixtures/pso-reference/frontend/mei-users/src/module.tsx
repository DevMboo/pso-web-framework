import { createMeiModule } from "@pso/frontend-react";
import mei from "../.pso/generated/mei";
import "./styles/index.css";

// What this microfrontend exposes to its host. Routes come from ROUTES.pso.ts; the host owns the browser history and the session.
export default createMeiModule(mei);
