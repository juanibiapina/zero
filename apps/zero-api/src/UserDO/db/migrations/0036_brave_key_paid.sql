-- Per-user canary flag: when set, this user's web searches use the paid Brave
-- key instead of the shared free one, so paid-plan search cost can be measured
-- on a small cohort before a wider rollout (see https://github.com/juanibiapina/zero/blob/574911e0df656ba5923198819c9ec5d061f623c6/docs/plans/brave-paid-canary.md).
-- Boolean as 0/1, default off, like onboardingSeen.
ALTER TABLE "user_settings" ADD COLUMN "braveKeyPaid" INTEGER NOT NULL DEFAULT 0;
