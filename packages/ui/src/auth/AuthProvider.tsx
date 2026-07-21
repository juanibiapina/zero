import { ClerkProvider } from "@clerk/clerk-react";
import type { ReactNode } from "react";

/**
 * Wraps the app in Clerk auth using the `VITE_CLERK_PUBLISHABLE_KEY` env var.
 * Shared across every Zero product so auth is configured identically.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

  if (!publishableKey) {
    throw new Error("Add your Clerk Publishable Key to the .env file");
  }

  return <ClerkProvider publishableKey={publishableKey}>{children}</ClerkProvider>;
}
