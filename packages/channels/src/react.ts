/**
 * Kept for compatibility: the React bindings live in @pso/react-channels, which a front end installs itself
 * (`pso install:react channels`). This server package no longer depends on it: the entry point works where that package is
 * installed and is not needed anywhere else. Prefer importing from "@pso/react-channels".
 * @deprecated import from "@pso/react-channels"
 */
export * from "@pso/react-channels";
