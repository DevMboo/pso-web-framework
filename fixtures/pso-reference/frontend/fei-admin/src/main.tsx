import { startFei } from "@pso/frontend-react";
import { customMiddlewares, fei, feiRoutes } from "../.pso/generated/fei";
import { AppShell } from "./layouts/AppShell";
import { Crash, Forbidden, Loading, NotFound, RemoteUnavailable } from "./components/ShellPages";
import { LoginPage } from "./security/LoginPage";
import "./styles/index.css";

// The whole bootstrap: the framework builds the session, the orchestrator client, the Channels connection, the middleware pipeline and the
// microfrontend loader from FEI.pso.ts. This file only chooses the visual pieces.
void startFei({
  fei,
  customMiddlewares,
  feiRoutes,
  Shell: AppShell,
  pages: { Login: LoginPage, Forbidden, NotFound, RemoteUnavailable, Loading, Crash },
});
