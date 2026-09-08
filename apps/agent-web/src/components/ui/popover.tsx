/* eslint-disable react-refresh/only-export-components -- radix primitives are
   re-exported as consts (Root/Trigger/Anchor); the rule can't see they are
   components. This is a shadcn-style primitive barrel, not a screen. */
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/lib/utils";

// A generic anchored popover: a floating panel positioned relative to a trigger.
// Built on @radix-ui/react-popover (the same radix family as the app's dialog and
// slot), so focus management, Esc-to-close, outside-click dismiss, ARIA, and
// collision-aware placement (flip/shift near the viewport edge) come for free — a
// hand-rolled version reliably gets those wrong. Enter/exit motion uses the
// tw-animate-css utilities the app already ships. It knows nothing about its
// content: callers pass `children` (e.g. the project icon emoji picker).
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
