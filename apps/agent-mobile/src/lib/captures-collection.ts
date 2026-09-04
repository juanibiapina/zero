import {
  createCapturesApi,
  type CapturesApi,
  type CapturesRest,
} from '@zero/agent-core';

import {
  addCapture,
  editCapture,
  fetchCaptures,
  processCapture,
  reorderCapture,
  rescheduleCapture,
  type TokenGetter,
} from './api';
import { defineMobileEntityApi } from './entity-api';

// The mobile Capture data layer: the shared factory bound to the Clerk token,
// as one app-lifetime singleton read by the Captures and Upcoming screens. The
// mechanics (singleton, token ref, offline SQLite + outbox, jest fallback) are
// in ./entity-api.
function makeRest(getToken: TokenGetter): CapturesRest {
  return {
    fetchCaptures: () => fetchCaptures(getToken),
    addCapture: (capture) => addCapture(getToken, capture),
    processCapture: (id) => processCapture(getToken, id),
    editCapture: (id, text) => editCapture(getToken, id, text),
    rescheduleCapture: (id, showUpDate) =>
      rescheduleCapture(getToken, id, showUpDate),
    reorderCapture: (id, sortKey) => reorderCapture(getToken, id, sortKey),
  };
}

const captures = defineMobileEntityApi<CapturesApi, CapturesRest>({
  create: createCapturesApi,
  makeRest,
});

export const getMobileCapturesApi = captures.get;
export const setCapturesTokenGetter = captures.setTokenGetter;
export const resetCapturesApiForTest = captures.resetForTest;
export const useCapturesApi = captures.useApi;
