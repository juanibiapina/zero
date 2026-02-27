import { NavLink } from "react-router";
import { useUser, UserButton } from "@clerk/clerk-react";
import {
  LayoutDashboard,
  FolderGit2,
  Settings,
  Plug,
  KeyRound,
  FileText,
  X,
  Loader2,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { useSessionStore } from "@/lib/session-store";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/projects", icon: FolderGit2, label: "Projects" },
  { to: "/secrets", icon: KeyRound, label: "Secrets" },
  { to: "/templates", icon: FileText, label: "Templates" },
];

const settingsItems = [
  { to: "/settings", icon: Settings, label: "Settings" },
  { to: "/settings/providers", icon: Plug, label: "Providers" },
];

// Status → dot color (matches StatusBadge palette)
const statusDotColor: Record<string, string> = {
  running: "bg-blue-500",
  starting: "bg-yellow-500",
  resuming: "bg-yellow-500",
  idle: "bg-green-500",
  stopped: "bg-muted-foreground/50",
  error: "bg-destructive",
};

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  visible?: boolean;
}

export default function Sidebar({ open, onClose, visible = true }: SidebarProps) {
  const { user } = useUser();
  const sessions = useSessionStore((s) => s.sessions);
  const loadingSessions = useSessionStore((s) => s.loading);

  const sidebarContent = (
    <>
      {/* Brand */}
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-2 font-semibold text-sidebar-foreground">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold">
            Z
          </div>
          <span>Zero</span>
        </div>
        {/* Close button — mobile only */}
        <button
          onClick={onClose}
          className="rounded-md p-1 text-sidebar-foreground hover:bg-sidebar-accent md:hidden"
          aria-label="Close menu"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <Separator />

      {/* Navigation */}
      <nav className="shrink-0 space-y-1 p-2">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            onClick={onClose}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}

        <Separator className="my-2" />

        {settingsItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end
            onClick={onClose}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <Separator />

      {/* Sessions */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 px-4 py-2">
          <MessageSquare className="h-3.5 w-3.5 text-sidebar-foreground/50" />
          <span className="text-xs font-medium uppercase tracking-wider text-sidebar-foreground/50">
            Sessions
          </span>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {loadingSessions && (
            <div className="flex items-center justify-center py-3 text-sidebar-foreground/50">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            </div>
          )}
          {!loadingSessions && sessions.length === 0 && (
            <p className="px-3 py-2 text-xs text-sidebar-foreground/40">
              No sessions yet
            </p>
          )}
          {sessions.map((session) => (
            <NavLink
              key={session.id}
              to={`/p/${session.owner}/${session.repo}/sessions/${session.id}`}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  "flex items-start gap-2 rounded-md px-3 py-2 transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )
              }
            >
              <span
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  statusDotColor[session.status] ?? "bg-muted-foreground/50"
                )}
                title={session.status}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium leading-snug">
                  {session.title}
                </span>
                <span className="block truncate text-xs text-sidebar-foreground/50">
                  {session.owner}/{session.repo}
                </span>
              </span>
            </NavLink>
          ))}
        </div>
      </div>

      {/* User */}
      <div className="shrink-0 border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2">
          <UserButton afterSignOutUrl="/" />
          <span className="truncate text-sm text-sidebar-foreground">
            {user?.firstName ?? user?.emailAddresses[0]?.emailAddress ?? "User"}
          </span>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar — toggleable at md+ */}
      <aside className={cn(
        "h-full w-56 flex-col border-r border-sidebar-border bg-sidebar transition-all duration-200",
        visible ? "md:flex" : "hidden"
      )}>
        {sidebarContent}
      </aside>

      {/* Mobile overlay sidebar */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={onClose}
            aria-hidden="true"
          />
          {/* Sidebar panel */}
          <aside className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-sidebar-border bg-sidebar md:hidden">
            {sidebarContent}
          </aside>
        </>
      )}
    </>
  );
}
