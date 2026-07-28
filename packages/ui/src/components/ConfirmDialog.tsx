/**
 * ============================================================================
 * ConfirmDialog: confirmation for a destructive, irreversible action
 * ============================================================================
 *
 * A controlled alert dialog that owns the whole confirm lifecycle, so call
 * sites hand it a promise and nothing else.
 *
 * Radix's Action is a close control: it closes the dialog on click, which would
 * hide any pending state and tear the dialog down before a failed request could
 * be retried. This module takes that over. It prevents the Action's default
 * close, keeps its own pending flag, and:
 *
 * - while `onConfirm` is pending, disables Confirm and Cancel and ignores close
 *   requests (Escape, outside interaction), so nothing can double submit or
 *   dismiss a request in flight;
 * - on resolve, calls `onOpenChange(false)`;
 * - on reject, stays open, clears pending, and calls `onError` once, so the
 *   caller can surface the message and the user can retry or cancel.
 */

import { useState, type MouseEvent, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** Awaited by the dialog; resolve closes it, reject keeps it open. */
  onConfirm: () => Promise<void>;
  onError?: (error: unknown) => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  onError,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (pending && !next) return;
    onOpenChange(next);
  };

  const handleConfirm = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    void onConfirm().then(
      () => {
        setPending(false);
        onOpenChange(false);
      },
      (error: unknown) => {
        setPending(false);
        onError?.(error);
      },
    );
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={handleConfirm}
          >
            {pending ? "Working..." : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
