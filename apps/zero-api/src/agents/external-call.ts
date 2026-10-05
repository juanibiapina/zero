// Classification for irreversible tool calls (sending mail, creating an event).
//
// A claim is taken before the request leaves, so a replay of the same tool_use
// id can be answered without firing it again. What the claim cannot decide on
// its own is what a *failure* means: an exception proves the tool did not return
// a result, not that the provider did nothing. A fetch that times out while
// reading the response is indistinguishable from one that never arrived, and the
// mail may well be sent.
//
// So the adapter, which is the only place that knows, says which it was:
//
// - `ExternalCallNotSent`: provable non-effect. The request never left, or the
//   provider rejected it outright (a 4xx that is not a timeout or a throttle).
//   The claim is completed and the model may try again.
// - anything else: unknown outcome. The claim stays in flight and the model is
//   told to stop and have the user check, because a retry could duplicate an
//   action the user cannot undo.

export class ExternalCallNotSent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalCallNotSent";
  }
}

// HTTP statuses that prove the provider did not act on the request. A 408
// (timeout) and a 429 (throttle) are excluded: both can follow a request that
// was already accepted, and 5xx says nothing about what happened server-side.
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 405, 409, 410, 422]);

export const isProvableRejection = (status: number): boolean =>
  REJECTED_STATUSES.has(status);
