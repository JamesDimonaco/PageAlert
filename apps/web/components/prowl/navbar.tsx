"use client";

import { Radar, Bell, LogOut, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { useRouter } from "next/navigation";

export function Navbar() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { tier } = useTier();

  const initials = user?.name?.charAt(0)?.toUpperCase() ?? user?.email?.charAt(0)?.toUpperCase() ?? "?";

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
          <nav className="hidden md:flex items-center gap-1">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm">Dashboard</Button>
            </Link>
            <Link href="/dashboard/logs">
              <Button variant="ghost" size="sm">Logs</Button>
            </Link>
            <Link href="/dashboard/settings">
              <Button variant="ghost" size="sm">Settings</Button>
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="relative">
            <Bell className="h-5 w-5" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger className="relative h-9 w-9 rounded-full hover:opacity-80 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
                      <Badge className={`text-[10px] px-1.5 py-0 ${
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
              <DropdownMenuItem onClick={() => router.push("/dashboard/settings")}>
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => signOut()}>
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
