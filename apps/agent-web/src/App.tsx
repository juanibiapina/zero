import { useCallback, useEffect, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useOutletContext,
} from "react-router";
import {
  ClerkProvider,
  SignIn,
  useAuth,
} from "@clerk/react";
import { CenteredPage } from "@/components/CenteredPage";
import { Loading } from "@/components/Loading";
import { DevToolbar } from "@/components/DevToolbar";
import { Onboarding } from "./pages/Onboarding";
import { SettingsPage } from "./pages/SettingsPage";
import { HomePage } from "./pages/HomePage";
import { AdminPage } from "./pages/AdminPage";
import { UserDetailPage } from "./pages/UserDetailPage";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

if (!PUBLISHABLE_KEY) {
  throw new Error("Add your Clerk Publishable Key to .env.local");
}

type AppContext = {
  onboardingSeen: boolean;
  setOnboardingSeen: (seen: boolean) => void;
  googleOnboardingStatus: string | null;
};

function useAppContext() {
  return useOutletContext<AppContext>();
}

function AuthGate() {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) return <Loading />;
  if (!isSignedIn) return <CenteredPage><SignIn /></CenteredPage>;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomeRoute />} />
        {/* Unlinked: reachable only by typing /captures. Keeps the GTD Captures
            list isolated from the current web app while it is dogfooded. */}
        <Route path="captures" element={<HomePage />} />
        <Route path="onboarding" element={<OnboardingRoute />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="admin/users/:userId" element={<UserDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function AppShell() {
  const navigate = useNavigate();
  const [onboardingSeen, setOnboardingSeen] = useState<boolean | null>(null);
  const [googleOnboardingStatus, setGoogleOnboardingStatus] = useState<string | null>(null);
  const resetOnboarding = useCallback(() => {
    setOnboardingSeen(false);
    void navigate("/onboarding");
  }, [navigate]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/user-settings");
      if (!res.ok) {
        if (!cancelled) setOnboardingSeen(true);
        return;
      }
      const data = (await res.json()) as { onboardingSeen: boolean; googleOnboardingStatus: string | null; createdAt: string | null; timezone: string | null };
      if (!cancelled) {
        setOnboardingSeen(data.onboardingSeen);
        setGoogleOnboardingStatus(data.googleOnboardingStatus);
      }
      // Keep the stored timezone in sync with this browser. Telegram carries no
      // timezone, so the web app is the only reliable source. Only PATCH when
      // it's missing or has changed (travel) — steady state is zero writes.
      const resolved = Intl.DateTimeFormat().resolvedOptions();
      const current = resolved.timeZone;
      if (current && current !== data.timezone) {
        let region: string | undefined;
        try {
          region = new Intl.Locale(resolved.locale).region;
        } catch {
          // The timezone remains useful when a browser reports an odd locale.
        }
        void fetch("/api/user-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            timezone: current,
            ...(region ? { region } : {}),
          }),
        });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (onboardingSeen === null) return <Loading />;

  const context: AppContext = { onboardingSeen, setOnboardingSeen, googleOnboardingStatus };

  return (
    <>
      <Outlet context={context} />
      <DevToolbar onResetOnboarding={resetOnboarding} />
    </>
  );
}

function HomeRoute() {
  const { onboardingSeen } = useAppContext();
  if (!onboardingSeen) return <Navigate to="/onboarding" replace />;
  return <SettingsPage />;
}

function OnboardingRoute() {
  const navigate = useNavigate();
  const { setOnboardingSeen, googleOnboardingStatus } = useAppContext();
  return (
    <Onboarding
      onComplete={() => {
        setOnboardingSeen(true);
        void navigate("/");
      }}
      googleOnboardingStatus={googleOnboardingStatus}
    />
  );
}

export default function App() {
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY!}>
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </ClerkProvider>
  );
}
