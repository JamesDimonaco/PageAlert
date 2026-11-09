"use client";

import { useState } from "react";
import { Radar, LogOut, Settings, ShieldCheck, Plus, MessageSquare, ScrollText } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { NotificationBell } from "@/components/prowl/notification-bell";
import { FeedbackDialog } from "@/components/prowl/feedback-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { useTier } from "@/hooks/use-tier";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useCreateMonitor } from "@/hooks/use-create-monitor";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

const NAV_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard/logs", label: "Logs" },
  { href: "/dashboard/settings", label: "Settings" },
];

export function Navbar() {
  const router = useRouter();
  const pathname = usePathname();
  const { open: openCreate } = useCreateMonitor();
  const { user, signOut } = useAuth();
  const { tier, grantUntil } = useTier();
  const isAdmin = useQuery(api.admin.isAdmin) === true;
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const initials = user?.name?.charAt(0)?.toUpperCase() ?? user?.email?.charAt(0)?.toUpperCase() ?? "?";
  // The dashboard index already leads with its own New monitor CTA
  const showCreate = pathname !== "/dashboard";

  return (
    <header className="sticky top-0 z-50 border-b border-border/30 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Radar className="h-5 w-5 text-primary" />
            </div>
            <span className="text-xl font-bold tracking-tight">PageAlert</span>
          </Link>
          <nav aria-label="Main" className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                aria-current={pathname === href ? "page" : undefined}
                className={buttonVariants({ variant: "ghost", size: "sm", className: "aria-[current=page]:bg-muted" })}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {showCreate && (
            <Button size="sm" onClick={openCreate} aria-label="New monitor" className="gap-1.5 shadow-sm shadow-primary/15 max-sm:min-w-11">
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New monitor</span>
            </Button>
          )}

          <Badge className={`text-xs px-1.5 py-0 hidden sm:inline-flex ${
            tier === "max"
              ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
              : tier === "pro"
                ? "bg-primary/10 text-primary border-primary/20"
                : "bg-muted text-muted-foreground border-border/50"
          }`}>
            {tier === "max" ? "Max" : tier === "pro" ? "Pro" : "Free"}{grantUntil && tier !== "free" ? " trial" : ""}
          </Badge>

          <NotificationBell />

          <DropdownMenu>
            <DropdownMenuTrigger aria-label="Account menu" className="relative flex h-9 w-9 max-sm:h-11 max-sm:w-11 items-center justify-center rounded-full hover:opacity-80 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Avatar className="h-9 w-9">
                {user?.image && <AvatarImage src={user.image} alt={user.name ?? "Profile"} />}
                <AvatarFallback className="bg-primary/10 text-primary text-sm font-semibold">
                  {initials}
                </AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56" align="end">
              <div className="flex items-center gap-2 p-2">
                <div className="flex flex-col space-y-0.5">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{user?.name ?? "User"}</p>
                    {tier !== "free" && (
                      <Badge className={`text-xs px-1.5 py-0 ${
                        tier === "max"
                          ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                          : "bg-primary/10 text-primary border-primary/20"
                      }`}>
                        {tier === "max" ? "Max" : "Pro"}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{user?.email}</p>
                </div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="md:hidden" onClick={() => router.push("/dashboard/logs")}>
                <ScrollText className="mr-2 h-4 w-4" />
                Logs
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push("/dashboard/settings")}>
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setFeedbackOpen(true)}>
                <MessageSquare className="mr-2 h-4 w-4" />
                Send feedback
              </DropdownMenuItem>
              {isAdmin && (
                <DropdownMenuItem onClick={() => router.push("/admin")}>
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  Admin
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => signOut()}>
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
        </div>
      </div>
    </header>
  );
}
