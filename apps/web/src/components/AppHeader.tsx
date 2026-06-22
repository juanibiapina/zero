import { UserButton } from "@clerk/react";

// Sticky top bar shared across the app so every authenticated screen
// (onboarding, settings, admin) reads as one continuous product.
export function AppHeader() {
  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
        <span className="text-xl font-bold tracking-tight">Zero</span>
        <UserButton appearance={{ elements: { avatarBox: "size-8" } }} />
      </div>
    </header>
  );
}
