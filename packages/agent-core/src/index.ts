// @zero/agent-core — shared, platform-agnostic app code.
// The Capture data layer (TanStack DB collection factory) shared by web + mobile.
export type { Capture } from "./captures/types";
export {
  CAPTURES_QUERY_KEY,
  createCapturesApi,
  createInMemoryApi,
  createPersistedApi,
  type CapturesApi,
  type CapturesRest,
  type StartOfflineExecutor,
  type WarnFn,
} from "./captures/collection";
