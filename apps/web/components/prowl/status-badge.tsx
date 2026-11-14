import { Badge } from "@/components/ui/badge";
import { Activity, Pause, AlertTriangle, Loader2 } from "lucide-react";

const statusConfig = {
  scanning: {
    label: "Scanning",
    icon: Loader2,
    className: "bg-blue-500/10 text-info border-blue-500/20 hover:bg-blue-500/15 [&_svg]:animate-spin",
  },
  active: {
    label: "Active",
    icon: Activity,
    className: "bg-emerald-500/10 text-success border-emerald-500/20 hover:bg-emerald-500/15",
  },
  paused: {
    label: "Paused",
    icon: Pause,
    className: "bg-amber-500/10 text-warning border-amber-500/20 hover:bg-amber-500/15",
  },
  error: {
    label: "Error",
    icon: AlertTriangle,
    className: "bg-red-500/10 text-destructive border-red-500/20 hover:bg-red-500/15",
  },
};

export function StatusBadge({ status }: { status: keyof typeof statusConfig }) {
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <Badge variant="outline" className={`gap-1.5 ${config.className}`}>
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}
