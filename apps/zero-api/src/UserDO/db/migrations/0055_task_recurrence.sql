-- Recurring tasks keep one row. `recurrence` is versioned canonical JSON and
-- `recurrenceDate` is the current occurrence's pattern date; showUpDate may
-- differ after a one-off postpone.
ALTER TABLE "tasks" ADD COLUMN "recurrence" TEXT;
ALTER TABLE "tasks" ADD COLUMN "recurrenceDate" TEXT;
