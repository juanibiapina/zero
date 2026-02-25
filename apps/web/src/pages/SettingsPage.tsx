import { Settings } from "lucide-react";

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>
      <p className="text-muted-foreground">
        General settings and preferences.
      </p>
    </div>
  );
}
