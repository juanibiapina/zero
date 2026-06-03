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
} from "@clerk/clerk-react";
import { CenteredPage } from "@/components/CenteredPage";
import { Loading } from "@/components/Loading";
import { DevToolbar } from "@/components/DevToolbar";
import { Onboarding } from "./pages/Onboarding";
import { SettingsPage } from "./pages/SettingsPage";
import { AdminPage } from "./pages/AdminPage";

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
        <Route path="onboarding" element={<OnboardingRoute />} />
        <Route path="admin" element={<AdminPage />} />
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
      const data = (await res.json()) as { onboardingSeen: boolean; googleOnboardingStatus: string | null; createdAt: string | null };
      if (!cancelled) {
        setOnboardingSeen(data.onboardingSeen);
        setGoogleOnboardingStatus(data.googleOnboardingStatus);
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
