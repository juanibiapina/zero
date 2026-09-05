import { useCallback, useEffect, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
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
import { SideNav } from "@/components/SideNav";
import { createWebTimezoneSync } from "./lib/timezone-sync";
import { Onboarding } from "./pages/Onboarding";
import { SettingsPage } from "./pages/SettingsPage";
import { HomePage } from "./pages/HomePage";
import { UpcomingPage } from "./pages/UpcomingPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
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
        {/* Unlinked from the marketing app like Captures; the second GTD
            section. Shows captures scheduled for a future day. */}
        <Route path="upcoming" element={<UpcomingPage />} />
        {/* Unlinked like Captures; the Projects list (entity #3). */}
        <Route path="projects" element={<ProjectsPage />} />
        {/* A project opens its own screen (a destination, not a sheet). */}
        <Route path="projects/:id" element={<ProjectDetailPage />} />
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
  const location = useLocation();
  // Onboarding is a standalone first-run flow: it keeps its own header and shows
  // no section nav.
  const showNav = location.pathname !== "/onboarding";
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
      // Silently sync the browser's timezone. The onboarding GET above seeds the
      // baseline. See docs/timezone.md.
      void createWebTimezoneSync().onColdStart(data.timezone);
    })();
    return () => { cancelled = true; };
  }, []);

  if (onboardingSeen === null) return <Loading />;

  const context: AppContext = { onboardingSeen, setOnboardingSeen, googleOnboardingStatus };

  return (
    <>
      {showNav ? <SideNav /> : null}
      {/* Offset the content for the sidebar (desktop) and the bottom bar
          (mobile); no offset on the chrome-free onboarding flow. */}
      <div className={showNav ? "pb-16 md:pb-0 md:pl-56" : undefined}>
        <Outlet context={context} />
      </div>
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
