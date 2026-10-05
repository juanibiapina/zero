-- The model's own response id for an assistant row.
--
-- Anthropic's cache diagnostics are chain-relative: a request names the previous
-- response it should be compared against. Until now that chain only existed
-- inside one run, so a cache break between turns was invisible. With an
-- append-only log, turn N+1's prefix genuinely extends turn N's, so the last
-- response id of a conversation is the right thing to chain from — which means
-- it has to be stored with the response.
ALTER TABLE "messages" ADD COLUMN "responseId" TEXT DEFAULT NULL;
