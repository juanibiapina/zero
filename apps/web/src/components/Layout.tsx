import { useState, useEffect } from "react";
import { Outlet, useNavigate } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";
import ProjectPickerDialog from "./ProjectPickerDialog";
import SessionPickerDialog from "./SessionPickerDialog";
import CommandPaletteDialog from "./CommandPaletteDialog";
import { useUserWebSocket } from "@/lib/use-user-websocket";
import { useSettingsStore } from "@/lib/settings-store";
import { useAction } from "@/lib/use-action";

export default function Layout() {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [sessionPickerKey, setSessionPickerKey] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const fetchSettings = useSettingsStore((s) => s.fetchSettings);

  // Fetch user settings on mount
  useEffect(() => {
    void fetchSettings(getToken);
  }, [fetchSettings, getToken]);

  const navigate = useNavigate();

  // Hotkey actions
  const dialogOpen = pickerOpen || sessionPickerOpen || paletteOpen;
  useAction("listSessions", () => { setSessionPickerKey((k) => k + 1); setSessionPickerOpen(true); }, { enabled: !dialogOpen });
  useAction("newSession", () => setPickerOpen(true), { enabled: !dialogOpen });
  useAction("commandPalette", () => setPaletteOpen(true), { enabled: !dialogOpen });
  useAction("goToDashboard", () => void navigate("/"), { enabled: !dialogOpen });
  useAction("goToProjects", () => void navigate("/projects"), { enabled: !dialogOpen });
  useAction("goToSecrets", () => void navigate("/secrets"), { enabled: !dialogOpen });
  useAction("goToSettings", () => void navigate("/settings"), { enabled: !dialogOpen });
  useAction("goToProviders", () => void navigate("/settings/providers"), { enabled: !dialogOpen });

  // User-level WebSocket for real-time push events
  useUserWebSocket();

  if (!isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!isSignedIn) {
    return null; // ClerkProvider handles redirect
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex h-14 items-center border-b px-4 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="rounded-md p-2 text-foreground hover:bg-muted"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="ml-2 flex items-center gap-2 font-semibold">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold">
              Z
            </div>
            <span>Zero</span>
          </div>
        </div>

        <main className="flex-1 overflow-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>

      <ProjectPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} />
      <SessionPickerDialog key={sessionPickerKey} open={sessionPickerOpen} onOpenChange={setSessionPickerOpen} />
      <CommandPaletteDialog
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenProjectPicker={() => setPickerOpen(true)}
        onOpenSessionPicker={() => { setSessionPickerKey((k) => k + 1); setSessionPickerOpen(true); }}
      />
    </div>
  );
}
