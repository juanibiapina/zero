/**
 * ============================================================================
 * AsyncState — loading / error / retry chrome for an async data region
 * ============================================================================
 *
 * Pairs with `useAsyncData`. Renders the muted `Loading...` text while a fetch
 * is in flight, an error block (message + Retry) when the fetch rejected, and
 * otherwise hands the resolved, non-null data to the render-prop child. The
 * child renders only the happy path and its own page-specific empty state.
 */

import type { ReactNode } from "react";
import { Button } from "./ui/button";
import type { AsyncData } from "../hooks/useAsyncData";

export interface AsyncStateProps<T> {
  state: Pick<AsyncData<T>, "data" | "loading" | "error">;
  onRetry: () => void;
  children: (data: T) => ReactNode;
}

export function AsyncState<T>({ state, onRetry, children }: AsyncStateProps<T>) {
  if (state.loading) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  if (state.error) {
    return (
      <div className="space-y-3">
        <p className="text-destructive">
          Failed to load: {state.error.message}
        </p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (state.data === null) {
    return null;
  }

  return <>{children(state.data)}</>;
}
