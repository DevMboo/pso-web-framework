import { JwtGuard } from "@pso/security";

// Authentication policy for every route that uses the "jwt" guard.
// Keys, issuer, audience and algorithms are declared in pso.config.json (security.authentication.*)
// and validated before the application starts. Run `pso security:validate` to check that configuration and `pso security:policy` to see the effective policy of every route.
export default JwtGuard.create();
