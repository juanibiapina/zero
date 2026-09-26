import { createWaitsApi, type WaitsApi, type WaitsRest } from '@zero/agent-core';

import {
  addWaitingCondition,
  deleteWaitingCondition,
  fetchWaits,
  resolveWaitingCondition,
  type TokenGetter,
} from './api';
import { defineMobileEntityApi } from './entity-api';

// REST-backed test adapter for screen tests. Production screens use the
// TinyBase APIs exposed by todo-data-context.
function makeRest(getToken: TokenGetter): WaitsRest {
  return {
    fetchWaits: () => fetchWaits(getToken),
    addWaitingCondition: (condition) => addWaitingCondition(getToken, condition),
    resolveWaitingCondition: (id) => resolveWaitingCondition(getToken, id),
    deleteWaitingCondition: (id) => deleteWaitingCondition(getToken, id),
  };
}

const waits = defineMobileEntityApi<WaitsApi, WaitsRest>({
  create: createWaitsApi,
  makeRest,
});

export const resetWaitsApiForTest = waits.resetForTest;
export const useRestWaitsApiForTest = waits.useApi;
