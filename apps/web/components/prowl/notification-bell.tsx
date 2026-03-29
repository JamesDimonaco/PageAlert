"use client";

import { Bell, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { formatDistanceToNow } from "date-fns";

export function NotificationBell() {
  const notifications = useQuery(api.userNotifications.list, { limit: 10 });
  const unreadCount = useQuery(api.userNotifications.unreadCount);
  const markRead = useMutation(api.userNotifications.markRead);
  const markAllRead = useMutation(api.userNotifications.markAllRead);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          {(unreadCount ?? 0) > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
              {unreadCount! > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80" align="end">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
          <p className="text-sm font-semibold">Notifications</p>
          {(unreadCount ?? 0) > 0 && (
            <button
              onClick={() => markAllRead()}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              <Check className="h-3 w-3" />
              Mark all read
            </button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {!notifications || notifications.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <Bell className="h-5 w-5 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No notifications yet</p>
            </div>
          ) : (
            notifications.map((notif) => (
              <button
                key={notif._id}
                onClick={() => {
                  if (!notif.read) markRead({ id: notif._id });
                }}
                className={`w-full text-left px-3 py-3 border-b border-border/20 last:border-0 hover:bg-muted/50 transition-colors ${
                  !notif.read ? "bg-primary/5" : ""
                }`}
              >
                <div className="flex items-start gap-2">
                  {!notif.read && (
                    <span className="mt-1.5 h-2 w-2 rounded-full bg-primary shrink-0" />
                  )}
                  <div className={!notif.read ? "" : "ml-4"}>
                    <p className="text-sm font-medium leading-snug">{notif.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{notif.message}</p>
                    <p className="text-[10px] text-muted-foreground/60 mt-1">
                      {formatDistanceToNow(notif.sentAt, { addSuffix: true })}
                    </p>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
