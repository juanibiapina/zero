import { UserButton } from "@clerk/react";
import { Link, NavLink } from "react-router";

import { cn } from "@/lib/utils";

// One signed-in navigation destination.
type NavItem = {
  to: string;
  label: string;
  icon: (props: { className?: string }) => React.ReactElement;
};

function InboxIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M4 4h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
    </svg>
  );
}

const NAV_ITEMS: NavItem[] = [
  { to: "/home", label: "Home", icon: InboxIcon },
  { to: "/upcoming", label: "Upcoming", icon: CalendarIcon },
  { to: "/projects", label: "Projects", icon: FolderIcon },
];

// Shared section navigation for the signed-in web app: a left sidebar on desktop
// and a bottom bar on small screens (the web mirror of the mobile tab bar).
// Mount once in the app shell.
export function SideNav() {
  return (
    <>
      {/* Desktop: fixed left rail. */}
      <aside className="fixed inset-y-0 left-0 z-50 hidden w-56 flex-col border-r bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:flex">
        <div className="flex h-14 items-center px-4">
          <Link to="/" className="text-xl font-bold tracking-tight">
            Zero
          </Link>
        </div>
        <nav className="flex-1 space-y-1 px-2 py-2">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )
              }
            >
              <Icon className="size-5" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-3 border-t p-4">
          <UserButton appearance={{ elements: { avatarBox: "size-8" } }} />
        </div>
      </aside>

      {/* Mobile: slim top bar (brand + user) plus a bottom nav bar. */}
      <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
        <Link to="/" className="text-xl font-bold tracking-tight">
          Zero
        </Link>
        <UserButton appearance={{ elements: { avatarBox: "size-8" } }} />
      </header>
      <nav className="fixed inset-x-0 bottom-0 z-50 flex h-16 items-stretch border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center justify-center gap-1 text-xs font-medium transition-colors",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )
            }
          >
            <Icon className="size-5" />
            {label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}
