import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useNavigate, useOutletContext } from "react-router";
import { ClerkProvider, SignIn, useAuth } from "@clerk/react";
import { Toaster } from "@/components/Toaster";
import { ToastLifecycle } from "@/components/toast-lifecycle";
import { CenteredPage } from "@/components/CenteredPage";
import { Loading } from "@/components/Loading";
import { DevToolbar } from "@/components/DevToolbar";
import { SideNav } from "@/components/SideNav";
import { createWebTimezoneSync } from "./lib/timezone-sync";
import { TodoDataProvider } from "./lib/todo-data";
import { Onboarding } from "./pages/Onboarding";
import { SettingsPage } from "./pages/SettingsPage";
import { HomePage } from "./pages/HomePage";
import { UpcomingPage } from "./pages/UpcomingPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
import { AdminPage } from "./pages/AdminPage";
import { UserDetailPage } from "./pages/UserDetailPage";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
if (!PUBLISHABLE_KEY) throw new Error("Add your Clerk Publishable Key to .env.local");

type AppContext = {
  onboardingSeen: boolean;
  setOnboardingSeen: (seen: boolean) => void;
  googleOnboardingStatus: string | null;
};

function TodoShell() {
  const navigate = useNavigate();
  const { isSignedIn, userId } = useAuth();
  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    void fetch("/api/user-settings").then(async (response) => {
      if (!response.ok) return;
      const settings = await response.json() as { timezone: string | null };
      if (!cancelled) await createWebTimezoneSync().onColdStart(settings.timezone);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isSignedIn, userId]);
  const resetOnboarding = useCallback(() => { void navigate("/onboarding"); }, [navigate]);
  return <>
    <SideNav />
    <div className="pb-16 md:pb-0 md:pl-56"><Outlet /></div>
    {isSignedIn ? <DevToolbar onResetOnboarding={resetOnboarding} /> : null}
    <ToastLifecycle />
    <Toaster />
  </>;
}

function AccountArea() {
  const { isSignedIn } = useAuth();
  return isSignedIn ? <AccountReady /> : <CenteredPage><SignIn forceRedirectUrl="/settings" /></CenteredPage>;
}

function AccountReady() {
  const [onboardingSeen, setOnboardingSeen] = useState<boolean | null>(null);
  const [googleOnboardingStatus, setGoogleOnboardingStatus] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/user-settings").then(async (response) => {
      if (!response.ok) throw new Error("Settings unavailable");
      const settings = await response.json() as { onboardingSeen: boolean; googleOnboardingStatus: string | null };
      if (!cancelled) { setOnboardingSeen(settings.onboardingSeen); setGoogleOnboardingStatus(settings.googleOnboardingStatus); }
    }).catch(() => { if (!cancelled) setOnboardingSeen(true); });
    return () => { cancelled = true; };
  }, []);
  if (onboardingSeen === null) return <Loading />;
  return <Outlet context={{ onboardingSeen, setOnboardingSeen, googleOnboardingStatus } satisfies AppContext} />;
}

function SettingsRoute() {
  const { onboardingSeen } = useOutletContext<AppContext>();
  return onboardingSeen ? <SettingsPage /> : <Navigate to="/onboarding" replace />;
}

function OnboardingRoute() {
  const navigate = useNavigate();
  const { setOnboardingSeen, googleOnboardingStatus } = useOutletContext<AppContext>();
  return <Onboarding onComplete={() => { setOnboardingSeen(true); void navigate("/settings"); }} googleOnboardingStatus={googleOnboardingStatus} />;
}

function AppRoutes() {
  const { isLoaded } = useAuth();
  if (!isLoaded) return <Loading />;
  return <TodoDataProvider><Routes>
    <Route element={<TodoShell />}>
      <Route index element={<Navigate to="/home" replace />} />
      <Route path="home" element={<HomePage />} />
      <Route path="upcoming" element={<UpcomingPage />} />
      <Route path="projects" element={<ProjectsPage />} />
      <Route path="projects/:id" element={<ProjectDetailPage />} />
      <Route path="sign-in/*" element={<CenteredPage><SignIn forceRedirectUrl="/home" /></CenteredPage>} />
      <Route element={<AccountArea />}>
        <Route path="settings" element={<SettingsRoute />} />
        <Route path="onboarding" element={<OnboardingRoute />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="admin/users/:userId" element={<UserDetailPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/home" replace />} />
    </Route>
  </Routes></TodoDataProvider>;
}

export default function App() {
  return <ClerkProvider publishableKey={PUBLISHABLE_KEY!}><BrowserRouter><AppRoutes /></BrowserRouter></ClerkProvider>;
}
