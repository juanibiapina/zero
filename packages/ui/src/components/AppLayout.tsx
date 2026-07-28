import { Link, Outlet, useLocation, useNavigate } from "react-router";
import {
  SignedIn,
  SignedOut,
  RedirectToSignIn,
  UserButton,
  OrganizationSwitcher,
  CreateOrganization,
  useOrganization,
} from "@clerk/clerk-react";
import { ExternalLink } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ProductId, ProductLink } from "../products";
import { Button } from "./ui/button";
import { Toaster } from "./ui/sonner";
import { cn } from "../lib/utils";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export interface AccountNav {
  /** Section heading above the items. Defaults to "Account". */
  label?: string;
  items: NavItem[];
}

export interface AppLayoutProps {
  /** Brand shown top-left: product name, the link target, and an optional icon. */
  brand: { name: string; icon?: LucideIcon; to: string };
  /** Primary nav links. */
  navItems: NavItem[];
  /**
   * Links that belong to the account rather than to a product. The shell owns
   * the region, its divider, its label, and where it goes on narrow widths, so
   * every app gets the same one.
   */
  accountNav?: AccountNav;
  /** Where Clerk sends the user after switching/creating an org. */
  afterOrgUrl?: string;
  /** Full Zero product list (same on every app). Omit to hide the switcher. */
  products?: ProductLink[];
  /** Which product this app is, so its row is highlighted. Omit outside a product. */
  currentProductId?: ProductId;
}

/**
 * The shared authenticated app shell: a Cloudflare-style left rail (brand +
 * product switcher + product nav + account nav) on desktop with a trimmed top
 * bar, collapsing to a top bar with a native product `<select>` and a
 * horizontal nav strip on mobile. Product-specific bits (brand, nav, current
 * product) are props so every Zero console is one visual family. The account
 * region sits below the product nav and outside the products, which is what
 * tells a user its pages are not owned by either product. A shell can render
 * with no current product (the account pages do): the switcher still lists
 * both products, with neither row marked current. Unauthenticated users are
 * redirected to sign-in.
 */
export function AppLayout({
  brand,
  navItems,
  accountNav,
  afterOrgUrl = "/",
  products,
  currentProductId,
}: AppLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isLoaded, organization } = useOrganization();
  const BrandIcon = brand.icon;

  const showSelector = products !== undefined;
  const accountLabel = accountNav?.label ?? "Account";
  const accountItems = accountNav?.items ?? [];

  // A route is active when the current path starts with it, so nested pages
  // keep their section lit. Every rail path is a unique prefix today; a future
  // sibling like /keys-something would light up /keys too.
  const isActive = (to: string) => location.pathname.startsWith(to);

  const onMobileProductChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = products?.find((p) => p.id === e.target.value);
    if (next && next.id !== currentProductId) {
      void navigate(next.href);
    }
  };

  return (
    <>
      <SignedIn>
        {!isLoaded ? (
          <div className="flex min-h-screen items-center justify-center bg-background">
            <p className="text-muted-foreground">Loading…</p>
          </div>
        ) : !organization ? (
          <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-4">
            <div className="text-center">
              <h1 className="text-xl font-semibold">
                Create your organization to get started
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Your projects, keys, and secrets live under an organization.
              </p>
            </div>
            <CreateOrganization afterCreateOrganizationUrl={afterOrgUrl} />
          </div>
        ) : (
          <div className="flex min-h-screen bg-background">
          {/* Desktop left rail */}
          <aside className="hidden md:flex md:w-60 md:flex-col md:border-r bg-background">
            <Link
              to={brand.to}
              className="flex h-14 items-center gap-2 border-b px-4"
            >
              {BrandIcon && <BrandIcon className="h-5 w-5" />}
              <span className="text-xl font-bold tracking-tight">{brand.name}</span>
            </Link>

            {showSelector && (
              <div className="flex flex-col gap-1 border-b p-2">
                {products.map((product) => {
                  const ProductIcon = product.icon;
                  const isCurrent = product.id === currentProductId;
                  const className = cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isCurrent
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  );
                  if (isCurrent) {
                    return (
                      <span key={product.id} className={className} aria-current="page">
                        <ProductIcon className="h-4 w-4" />
                        {product.label}
                      </span>
                    );
                  }
                  return (
                    <Link key={product.id} to={product.href} className={className}>
                      <ProductIcon className="h-4 w-4" />
                      {product.label}
                    </Link>
                  );
                })}
              </div>
            )}

            <nav aria-label="Product" className="flex flex-1 flex-col gap-1 p-2">
              {navItems.map((item) => (
                <Button
                  key={item.to}
                  variant="ghost"
                  size="sm"
                  asChild
                  className={cn(
                    "justify-start",
                    isActive(item.to) && "bg-accent text-accent-foreground",
                  )}
                >
                  <Link to={item.to}>
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                </Button>
              ))}
            </nav>

            {accountItems.length > 0 && (
              <nav aria-label={accountLabel} className="flex flex-col gap-1 border-t p-2">
                <span className="px-3 py-1 text-xs font-medium text-muted-foreground">
                  {accountLabel}
                </span>
                {accountItems.map((item) => (
                  <Button
                    key={item.to}
                    variant="ghost"
                    size="sm"
                    asChild
                    className={cn(
                      "justify-start",
                      isActive(item.to) && "bg-accent text-accent-foreground",
                    )}
                  >
                    <Link to={item.to} aria-current={isActive(item.to) ? "page" : undefined}>
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  </Button>
                ))}
              </nav>
            )}

            <a
              href="https://docs.zeroapps.dev/"
              target="_blank"
              rel="noreferrer"
              className="mt-auto flex items-center gap-2 border-t px-4 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Docs
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </aside>

          {/* Content column */}
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-50 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:px-6 lg:px-8">
              {/* Mobile brand + product switcher */}
              <div className="flex items-center gap-2 md:hidden">
                <Link to={brand.to} className="flex items-center gap-2">
                  {BrandIcon && <BrandIcon className="h-5 w-5" />}
                  <span className="text-lg font-bold tracking-tight">{brand.name}</span>
                </Link>
                {showSelector && (
                  <select
                    aria-label="Switch product"
                    value={currentProductId ?? ""}
                    onChange={onMobileProductChange}
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {currentProductId === undefined && (
                      <option value="" disabled>
                        {accountLabel}
                      </option>
                    )}
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="ml-auto flex items-center gap-2">
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
            </header>

            {/* Mobile nav strip: product links, then the account links */}
            {(navItems.length > 0 || accountItems.length > 0) && (
              <nav
                aria-label={`Product and ${accountLabel.toLowerCase()}`}
                className="md:hidden border-b bg-background px-4 py-2 flex gap-1 overflow-x-auto"
              >
                {navItems.map((item) => (
                  <Button
                    key={item.to}
                    variant="ghost"
                    size="sm"
                    asChild
                    className={cn(
                      "flex-shrink-0",
                      isActive(item.to) && "bg-accent text-accent-foreground",
                    )}
                  >
                    <Link to={item.to}>
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  </Button>
                ))}

                {navItems.length > 0 && accountItems.length > 0 && (
                  <span aria-hidden className="mx-1 h-5 w-px shrink-0 self-center bg-border" />
                )}

                {accountItems.map((item) => (
                  <Button
                    key={item.to}
                    variant="ghost"
                    size="sm"
                    asChild
                    className={cn(
                      "flex-shrink-0",
                      isActive(item.to) && "bg-accent text-accent-foreground",
                    )}
                  >
                    <Link to={item.to} aria-current={isActive(item.to) ? "page" : undefined}>
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  </Button>
                ))}
              </nav>
            )}

            <main className="container mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
              <Outlet />
            </main>
          </div>

            <Toaster position="bottom-right" />
          </div>
        )}
      </SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </>
  );
}
