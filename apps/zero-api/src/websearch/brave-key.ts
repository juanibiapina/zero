// Which Brave key a turn uses, and the cohort tag that goes on its log lines.
// Pure, so the canary routing is testable without a Durable Object.
//
// The paid key is a per-user canary (see docs/plans/brave-paid-canary.md): only
// flagged users use it, so paid-plan search cost can be measured on a small
// cohort before a wider rollout. Everyone else uses the free key.

export type BraveCohort = "paid" | "free";

// Pick the paid key only when the user is flagged AND a non-empty paid key is
// configured. If the flag is set but the paid key is missing, fall back to the
// free key tagged "free": a missing secret must never break search, and the
// cohort tag then truthfully shows the request stayed on free.
export const selectBraveKey = (input: {
  paid: boolean;
  freeKey: string;
  paidKey: string | undefined;
}): { apiKey: string; cohort: BraveCohort } => {
  if (input.paid && input.paidKey) {
    return { apiKey: input.paidKey, cohort: "paid" };
  }
  return { apiKey: input.freeKey, cohort: "free" };
};
