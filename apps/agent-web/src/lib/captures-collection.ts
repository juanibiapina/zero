import { createCapturesApi, type CapturesApi } from "@zero/agent-core";

import {
  addCapture,
  editCapture,
  fetchCaptures,
  processCapture,
  reorderCapture,
  rescheduleCapture,
} from "./captures";
import { defineWebEntityApi } from "./entity-api";

export type { CapturesApi };

// The web Capture data layer, a per-tab singleton (see ./entity-api).
export const getCapturesApi = defineWebEntityApi((deps) =>
  createCapturesApi({
    ...deps,
    rest: {
      fetchCaptures,
      addCapture,
      processCapture,
      editCapture,
      rescheduleCapture,
      reorderCapture,
    },
  }),
);
