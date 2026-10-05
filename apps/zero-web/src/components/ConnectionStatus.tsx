// Shared connection-state primitives so onboarding and settings render
// "connected" and error states identically.

export function ConnectedStatus({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="inline-block size-2 shrink-0 rounded-full bg-emerald-500" />
      <span className="text-muted-foreground">{children}</span>
    </div>
  );
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-destructive">{children}</p>;
}
