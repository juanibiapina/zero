// What an entity's list region should show, decided once and shared by every
// web and mobile screen so the local-first rule lives in one tested place.
//
// The rule: never hide existing rows behind a spinner. The replica-backed
// collection publishes its local snapshot before the live query settles, so
// `isLoading` can stay true while rows already exist. Gating on the row count
// paints the snapshot at once and lets synchronization update it in place. The
// spinner shows only when there is genuinely nothing yet, which also stops an
// empty-state flash before hydration.
export type ListView = "rows" | "loading" | "empty";

// How long a list may sit empty-and-loading before it shows the "Loading…" text.
// The local snapshot hydrates cached rows in well under this, so a normal load
// paints straight to the list with no spinner flash; the text only appears on a
// genuinely slow first load (empty cache waiting on the network). Shared by every
// list screen so the delay is tuned in one place.
export const LOADING_TEXT_DELAY_MS = 1000;

export function listView(state: {
  count: number;
  isLoading: boolean;
}): ListView {
  if (state.count > 0) return "rows";
  if (state.isLoading) return "loading";
  return "empty";
}
