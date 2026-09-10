import { formatDistanceStrict } from "date-fns/formatDistanceStrict";

// A readable "how long waiting" phrase for a blocked-since instant, e.g.
// "3 days", "2 months", "1 year". No "ago" suffix: the Waiting section header
// already frames it, and the wait is ongoing, not a past event. `now` is
// injectable (formatDistanceStrict takes both endpoints) so the label is
// deterministic in tests; production passes the default. A sub-minute wait reads
// "just now" instead of the noisy "0 seconds" date-fns would emit.
export function waitingLabel(sinceIso: string, now: Date = new Date()): string {
  const since = new Date(sinceIso);
  if (now.getTime() - since.getTime() < 60_000) return "just now";
  return formatDistanceStrict(since, now, { addSuffix: false });
}
