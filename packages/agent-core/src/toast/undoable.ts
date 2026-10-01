import type { Transaction } from "@tanstack/db";

import { messageOf } from "../errors";
import {
  toast,
  type ToastAction,
  type ToastDescriptionAction,
} from "./controller";

// Commit an optimistic action immediately, then raise the single shared Undo
// snackbar whose action runs the inverse verb. The fixed "undo" toast id is owned
// here, so only one undoable-action toast is ever on screen, app-wide — a second
// call replaces the first. Both transaction promises route their failure to
// onError, so callers can't drift on error handling. React-free (only toast +
// messageOf), so it lives in @zero/agent-core and every surface shares it.
//
// `act`/`undo` return the entity collection's optimistic Transaction (e.g.
// () => api.complete(id) and () => api.reopen(id)); a page surfaces a write error
// via tx.isPersisted.promise.
export function undoableAction(opts: {
  message: string | (() => string);
  act: () => Transaction;
  undo: () => Transaction;
  onError: (message: string) => void;
  // Optional secondary line and navigation link (e.g. the completed task's
  // project name and a jump to its screen), rendered beside the Undo action.
  description?: string;
  descriptionAction?: ToastDescriptionAction;
  secondaryAction?: ToastAction;
  link?: ToastAction;
}): void {
  opts.act().isPersisted.promise.catch((e) => opts.onError(messageOf(e)));
  toast(typeof opts.message === "function" ? opts.message() : opts.message, {
    id: "undo",
    description: opts.description,
    descriptionAction: opts.descriptionAction,
    secondaryAction: opts.secondaryAction,
    link: opts.link,
    action: {
      label: "Undo",
      onPress: () => {
        opts.undo().isPersisted.promise.catch((e) => opts.onError(messageOf(e)));
      },
    },
  });
}
