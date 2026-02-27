import { useState } from "react";
import { Outlet } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { useHotkeySequence } from "@tanstack/react-hotkeys";
import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";
import ProjectPickerDialog from "./ProjectPickerDialog";
import { useUserWebSocket } from "@/lib/use-user-websocket";

export default function Layout() {
  const { isSignedIn, isLoaded } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Ctrl+Space → N: open project picker to create a new session (tmux-style prefix)
  useHotkeySequence(["Control+Space", "N"], () => setPickerOpen(true), {
    enabled: !pickerOpen,
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
    </div>
  );
}
