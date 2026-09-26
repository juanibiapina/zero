import type { PlainDate, Recurrence } from "@zeroapps/recurrence";

export interface Task {
  id: string;
  text: string;
  showUpDate: PlainDate | null;
  recurrence: Recurrence | null;
  recurrenceDate: PlainDate | null;
  createdAt: string;
  completedAt: string | null;
  projectId: string | null;
  sourceCaptureId: string | null;
  sortKey: string | null;
}
