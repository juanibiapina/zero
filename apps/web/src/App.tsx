import { useCallback, useEffect, useState } from "react";
import {
  ClerkProvider,
  SignIn,
  useAuth,
} from "@clerk/clerk-react";
import { CenteredPage } from "@/components/CenteredPage";
import { Loading } from "@/components/Loading";
import { DevToolbar } from "@/components/DevToolbar";
import { Onboarding } from "./pages/Onboarding";
import { SettingsPage } from "./pages/SettingsPage";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

if (!PUBLISHABLE_KEY) {
  throw new Error("Add your Clerk Publishable Key to .env.local");
}

function AuthGate() {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) return <Loading />;
  if (!isSignedIn) return <CenteredPage><SignIn /></CenteredPage>;

  return <AppShell />;
}

function AppShell() {
  const [onboardingSeen, setOnboardingSeen] = useState<boolean | null>(null);
  const resetOnboarding = useCallback(() => setOnboardingSeen(false), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/user-settings");
      if (!res.ok) {
        if (!cancelled) setOnboardingSeen(true);
        return;
      }
      const data = (await res.json()) as { onboardingSeen: boolean };
      if (!cancelled) setOnboardingSeen(data.onboardingSeen);
    })();
    return () => { cancelled = true; };
  }, []);

  if (onboardingSeen === null) return <Loading />;

  return (
    <>
      {onboardingSeen
        ? <SettingsPage />
        : <Onboarding onComplete={() => setOnboardingSeen(true)} />
      }
      <DevToolbar onResetOnboarding={resetOnboarding} />
    </>
  );
}

export default function App() {
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY!}>
      <AuthGate />
    </ClerkProvider>
  );
}
