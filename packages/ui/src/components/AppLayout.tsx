import { Link, Outlet, useLocation } from "react-router";
import {
  SignedIn,
  SignedOut,
  RedirectToSignIn,
  UserButton,
  OrganizationSwitcher,
} from "@clerk/clerk-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Toaster } from "./ui/sonner";
import { cn } from "../lib/utils";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export interface AppLayoutProps {
  /** Brand shown top-left: product name, icon, and the link target. */
  brand: { name: string; icon: LucideIcon; to: string };
  /** Primary nav links. */
  navItems: NavItem[];
  /** Where Clerk sends the user after switching/creating an org. */
  afterOrgUrl?: string;
}

/**
 * The shared authenticated app shell: sticky header with brand + nav, org
 * switcher and user button, a responsive mobile nav, and a content outlet.
 * Product-specific bits (brand, nav) are props so every Zero dashboard is one
 * visual family. Unauthenticated users are redirected to sign-in.
 */
export function AppLayout({ brand, navItems, afterOrgUrl = "/" }: AppLayoutProps) {
  const location = useLocation();
  const BrandIcon = brand.icon;

  return (
    <>
      <SignedIn>
        <div className="min-h-screen bg-background">
          <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="container mx-auto flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
              <Link to={brand.to} className="flex items-center gap-2">
                <BrandIcon className="h-5 w-5" />
                <span className="text-xl font-bold tracking-tight">{brand.name}</span>
              </Link>

              <nav className="hidden md:flex items-center gap-1">
                {navItems.map((item) => (
                  <Button
                    key={item.to}
                    variant="ghost"
                    size="sm"
                    asChild
                    className={cn(
                      location.pathname.startsWith(item.to) && "bg-accent text-accent-foreground"
                    )}
                  >
                    <Link to={item.to}>
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  </Button>
                ))}
              </nav>

              <div className="flex items-center gap-2">
                <OrganizationSwitcher
                  afterSelectOrganizationUrl={afterOrgUrl}
                  afterCreateOrganizationUrl={afterOrgUrl}
                  appearance={{
                    elements: {
                      organizationSwitcherTrigger: "py-1.5",
                    },
                  }}
                />
                <UserButton
                  appearance={{
                    elements: {
                      avatarBox: "size-8",
                    },
                  }}
                />
              </div>
            </div>
          </header>

          <nav className="md:hidden border-b bg-background px-4 py-2 flex gap-1 overflow-x-auto">
            {navItems.map((item) => (
              <Button
                key={item.to}
                variant="ghost"
                size="sm"
                asChild
                className={cn(
                  "flex-shrink-0",
                  location.pathname.startsWith(item.to) && "bg-accent text-accent-foreground"
                )}
              >
                <Link to={item.to}>
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              </Button>
            ))}
          </nav>

          <main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
            <Outlet />
          </main>

          <Toaster position="bottom-right" />
        </div>
      </SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </>
  );
}
