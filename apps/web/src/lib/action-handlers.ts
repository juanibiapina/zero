/**
 * Global action handler registry.
 *
 * Page-level components register handlers for context-dependent actions
 * (e.g. SessionPage registers "switchProvider" / "switchModel").
 * The CommandPaletteDialog reads from this store to include them.
 *
 * Handlers are registered on mount and unregistered on unmount via
 * useRegisterAction().
 */

import { useEffect } from "react";
import { create } from "zustand";

interface ActionHandlerStore {
  handlers: Record<string, () => void>;
  register: (actionId: string, handler: () => void) => void;
  unregister: (actionId: string) => void;
}

export const useActionHandlerStore = create<ActionHandlerStore>((set) => ({
  handlers: {},

  register: (actionId, handler) => {
    set((state) => ({
      handlers: { ...state.handlers, [actionId]: handler },
    }));
  },

  unregister: (actionId) => {
    set((state) => {
      const next = { ...state.handlers };
      delete next[actionId];
      return { handlers: next };
    });
  },
}));

/**
 * Register an action handler for the lifetime of the component.
 * The handler appears in the command palette while the component is mounted.
 */
export function useRegisterAction(actionId: string, handler: () => void) {
  const register = useActionHandlerStore((s) => s.register);
  const unregister = useActionHandlerStore((s) => s.unregister);

  useEffect(() => {
    register(actionId, handler);
    return () => unregister(actionId);
  }, [actionId, handler, register, unregister]);
}
