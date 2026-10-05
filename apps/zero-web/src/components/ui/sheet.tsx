import * as Dialog from "@radix-ui/react-dialog";

import { cn } from "@/lib/utils";

// A generic, entity-agnostic bottom sheet: a slide-up panel anchored to the
// bottom of the viewport. Built on @radix-ui/react-dialog (maintained, and
// already the family of `@radix-ui/react-slot` this app uses), so focus trap,
// Esc-to-close, backdrop dismiss, scroll-lock, and ARIA come for free — a
// hand-rolled sheet reliably gets those wrong. Enter/exit motion uses the
// tw-animate-css utilities the app already ships, which Radix awaits before
// unmounting.
//
// It knows nothing about any entity: callers pass `children`. Task details,
// completion feedback, and Project edit flows render their content inside it.
// `title` is shown as the sheet heading and
// doubles as the required accessible name; pass `srOnlyTitle` to keep the name
// for screen readers without a visible heading.
export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  srOnlyTitle?: boolean;
  children: React.ReactNode;
};

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function Sheet({
  open,
  onClose,
  title,
  srOnlyTitle,
  children,
}: SheetProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85vh] w-full max-w-2xl flex-col gap-4 rounded-t-2xl border bg-background p-6 shadow-lg focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom">
          <div className="flex items-center justify-between">
            <Dialog.Title className={cn(srOnlyTitle && "sr-only")}>
              {srOnlyTitle ? (
                title
              ) : (
                <span className="text-lg font-semibold tracking-tight">
                  {title}
                </span>
              )}
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <CloseIcon className="size-5" />
            </Dialog.Close>
          </div>
          <div className="overflow-y-auto">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
