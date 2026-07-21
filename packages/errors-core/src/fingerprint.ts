/**
 * ============================================================================
 * Fingerprinting — group repeated occurrences of the same bug
 * ============================================================================
 *
 * A pure function: same bug (varying per-occurrence ids) collapses to one
 * fingerprint; different project/message/frame do not. Kept dependency-free
 * so it is unit-testable in isolation and reusable by the web for display.
 */

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RE = /\b[0-9a-f]{8,}\b/gi;
const NUM_RE = /\b\d+\b/g;

/**
 * Strips the parts of a message that vary per occurrence (ids, hashes,
 * counters) so repeats of the same bug normalize to identical text.
 * Order matters: uuids before bare hex before numbers.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(UUID_RE, "<uuid>")
    .replace(HEX_RE, "<hex>")
    .replace(NUM_RE, "<n>")
    .trim();
}

/**
 * The first meaningful stack frame (the `at ...` line), used to distinguish
 * two bugs that share a message but originate in different code. Returns "" when
 * there is no usable stack.
 */
export function firstFrame(stack: string | undefined | null): string {
  if (!stack) return "";
  const lines = stack.split("\n").map((l) => l.trim());
  const frame = lines.find((l) => l.startsWith("at "));
  return frame ?? "";
}

export interface FingerprintInput {
  project: string;
  message: string;
  stack?: string | null;
}

/**
 * sha256(project + norm(message) + firstFrame(stack)) as lowercase hex.
 */
export async function fingerprint(input: FingerprintInput): Promise<string> {
  const parts = [
    input.project,
    normalizeMessage(input.message),
    firstFrame(input.stack),
  ].join("\n");
  const data = new TextEncoder().encode(parts);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
