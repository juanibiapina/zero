import { createWaitsApi, type WaitsApi } from "@zero/agent-core";

import { defineWebEntityApi } from "./entity-api";
import {
  addWaitingCondition,
  deleteWaitingCondition,
  fetchWaits,
  resolveWaitingCondition,
} from "./waits";

export type { WaitsApi };

// The web waiting-condition data layer, a per-tab singleton (see ./entity-api).
export const getWaitsApi = defineWebEntityApi((deps) =>
  createWaitsApi({
    ...deps,
    rest: {
      fetchWaits,
      addWaitingCondition,
      resolveWaitingCondition,
      deleteWaitingCondition,
    },
  }),
);
