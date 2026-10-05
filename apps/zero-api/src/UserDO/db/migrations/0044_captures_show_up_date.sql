-- Postpone: a capture can be pushed to a future day. showUpDate is a local
-- calendar day (YYYY-MM-DD) the capture should reappear on; NULL means always
-- visible (a plain capture). Nullable with no default so every existing row
-- stays visible. The visibility filter (showUpDate IS NULL OR showUpDate <=
-- today) runs server-side, where the DO derives today from the user's timezone.
ALTER TABLE "captures" ADD COLUMN "showUpDate" TEXT;
