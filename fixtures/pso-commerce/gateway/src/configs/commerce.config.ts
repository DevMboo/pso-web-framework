/**
 * Configuration "commerce" of this application.
 *
 * A plain module: the values are read once, when it is first imported, and it is used by importing it where it is needed:
 *
 *   import commerceConfig from "../../configs/commerce.config";
 *
 * The framework neither loads nor injects it, and it is not where framework settings live (limits, security, logging and
 * dispatch are in pso.config.json; see `pso config:list`). Read secrets from the environment, never write them here.
 */
export default Object.freeze({
  name: "commerce",
  // example: bucket: process.env["STORAGE_BUCKET"] ?? "local",
});
