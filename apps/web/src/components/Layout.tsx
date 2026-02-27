import { useState, useEffect } from "react";
import { Outlet } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { useHotkeySequence } from "@tanstack/react-hotkeys";
import type { Hotkey } from "@tanstack/react-hotkeys";
import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";
import ProjectPickerDialog from "./ProjectPickerDialog";
import CommandPaletteDialog from "./CommandPaletteDialog";
import { useUserWebSocket } from "@/lib/use-user-websocket";
import { useSettingsStore } from "@/lib/settings-store";

export default function Layout() {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const prefix = useSettingsStore((s) => s.settings.hotkeyPrefix) as Hotkey;
  const fetchSettings = useSettingsStore((s) => s.fetchSettings);

  // Fetch user settings on mount
  useEffect(() => {
    void fetchSettings(getToken);
  }, [fetchSettings, getToken]);

  // Prefix → N: open project picker to create a new session
  useHotkeySequence([prefix, "N"], () => setPickerOpen(true), {
    enabled: !pickerOpen && !paletteOpen,
  });

  // Prefix → P: open command palette
  useHotkeySequence([prefix, "P"], () => setPaletteOpen(true), {
    enabled: !paletteOpen && !pickerOpen,
  });

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
      <CommandPaletteDialog
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenProjectPicker={() => setPickerOpen(true)}
      />
    </div>
  );
}
