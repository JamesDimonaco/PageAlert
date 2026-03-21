import { Badge } from "@/components/ui/badge";
import { Activity, Pause, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

const statusConfig = {
  scanning: {
    label: "Scanning",
    icon: Loader2,
    className: "bg-blue-500/10 text-blue-400 border-blue-500/20 hover:bg-blue-500/15 [&_svg]:animate-spin",
  },
  active: {
    label: "Active",
    icon: Activity,
    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/15",
  },
  paused: {
    label: "Paused",
    icon: Pause,
    className: "bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/15",
  },
  error: {
    label: "Error",
    icon: AlertTriangle,
    className: "bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/15",
  },
  matched: {
    label: "Matched",
    icon: CheckCircle2,
    className: "bg-primary/10 text-primary border-primary/20 hover:bg-primary/15",
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
