import { Loader2, CircleCheck, CircleAlert } from "lucide-react";

interface StatusConfig {
  label: string;
  icon: React.ReactNode;
  className: string;
}

const configs: Record<string, StatusConfig> = {
  creating: {
    label: "Creating",
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
    className: "text-yellow-600",
  },
  connecting: {
    label: "Connecting",
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
    className: "text-muted-foreground",
  },
  starting: {
    label: "Starting",
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
    className: "text-yellow-600",
  },
  resuming: {
    label: "Resuming",
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
    className: "text-yellow-600",
  },
  running: {
    label: "Running",
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
    className: "text-blue-600",
  },
  idle: {
    label: "Idle",
    icon: <CircleCheck className="h-3 w-3" />,
    className: "text-green-600",
  },
  error: {
    label: "Error",
    icon: <CircleAlert className="h-3 w-3" />,
    className: "text-destructive",
  },
};

export function StatusBadge({ status }: { status: string }) {
  const c = configs[status] ?? {
    label: status,
    icon: null,
    className: "text-muted-foreground",
  };

  return (
    <span className={`flex items-center gap-1 text-xs font-medium ${c.className}`}>
      {c.icon}
      {c.label}
    </span>
  );
}
