import { NavLink } from "react-router";
import { useUser, UserButton } from "@clerk/clerk-react";
import {
  LayoutDashboard,
  FolderGit2,
  Settings,
  Plug,
  KeyRound,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/projects", icon: FolderGit2, label: "Projects" },
  { to: "/secrets", icon: KeyRound, label: "Secrets" },
];

const settingsItems = [
  { to: "/settings", icon: Settings, label: "Settings" },
  { to: "/settings/providers", icon: Plug, label: "Providers" },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const { user } = useUser();

  const sidebarContent = (
    <>
      {/* Brand */}
      <div className="flex h-14 items-center justify-between px-4">
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
      <nav className="flex-1 space-y-1 p-2">
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

      {/* User */}
      <div className="border-t border-sidebar-border p-3">
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
      {/* Desktop sidebar — always visible at md+ */}
      <aside className="hidden md:flex h-full w-56 flex-col border-r border-sidebar-border bg-sidebar">
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
