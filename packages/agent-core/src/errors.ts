// The error-to-message helper every screen uses to surface a write/load failure.
// One copy so the six list screens (web + mobile) never redeclare it.
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
