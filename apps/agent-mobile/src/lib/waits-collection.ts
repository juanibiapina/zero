import { createWaitsApi, type WaitsApi, type WaitsRest } from '@zero/agent-core';

import {
  addWaitingCondition,
  deleteWaitingCondition,
  fetchWaits,
  resolveWaitingCondition,
  type TokenGetter,
} from './api';
import { defineMobileEntityApi } from './entity-api';
import { RUNTIME_PROFILE } from './runtime-profile';
import { useTaskDOFixtureContext } from './taskdo-fixture-context';

// The mobile waiting-condition data layer: the shared factory bound to the Clerk
// token. Mechanics (singleton, token ref, offline SQLite + outbox, jest
// fallback) are in ./entity-api.
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

export const getMobileWaitsApi = waits.get;
export const setWaitsTokenGetter = waits.setTokenGetter;
export const resetWaitsApiForTest = waits.resetForTest;
export const useWaitsApi: () => WaitsApi | null =
  RUNTIME_PROFILE.hermetic && process.env.EXPO_PUBLIC_TASKDO_PROOF === '1'
    ? () => useTaskDOFixtureContext()?.waitsApi ?? null
    : waits.useApi;
