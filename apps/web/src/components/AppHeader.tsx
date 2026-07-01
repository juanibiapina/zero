import { UserButton } from "@clerk/react";
import { Link } from "react-router";
import { useFeature } from "@/lib/features";

// Sticky top bar shared across the app so every authenticated screen
// (onboarding, settings, admin) reads as one continuous product.
export function AppHeader() {
  const chatEnabled = useFeature("chat");
  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link to="/" className="text-xl font-bold tracking-tight">Zero</Link>
          {chatEnabled && (
            <nav className="flex items-center gap-4 text-sm text-muted-foreground">
              <Link to="/chat" className="hover:text-foreground">Chat</Link>
              <Link to="/" className="hover:text-foreground">Settings</Link>
            </nav>
          )}
        </div>
        <UserButton appearance={{ elements: { avatarBox: "size-8" } }} />
      </div>
    </header>
  );
}
