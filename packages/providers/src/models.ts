/**
 * Model catalog — thin re-export from pi-ai's models module.
 *
 * These deep imports bypass pi-ai's barrel (which pulls in heavy vendor SDKs)
 * and only load the pure-data model catalog.
 */

export {
  getProviders,
  getModels,
  getModel,
  calculateCost,
  modelsAreEqual,
} from "@mariozechner/pi-ai/dist/models.js";

export type {
  KnownProvider,
  Provider,
  Api,
  KnownApi,
  Model,
} from "@mariozechner/pi-ai/dist/types.js";
