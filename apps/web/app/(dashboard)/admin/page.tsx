"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdminOverview } from "@/components/admin/overview";
import { AdminUsersTable } from "@/components/admin/users-table";
import { AdminEmailComposer } from "@/components/admin/email-composer";

type AdminTab = "overview" | "users" | "email";

export default function AdminPage() {
  const [tab, setTab] = useState<AdminTab>("overview");
  // Selection lives here so "Email selected" on the Users tab can carry
  // recipients across to the Email tab.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Draft lives here (not in the composer) so it survives switching to the
  // Users tab and back.
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Admin</h1>
        <p className="text-sm text-muted-foreground mt-1">Users, revenue, monitors, and outbound email.</p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as AdminTab)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="email">
            Email{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <AdminOverview />
        </TabsContent>
        <TabsContent value="users" className="mt-6">
          <AdminUsersTable
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            onEmailSelected={() => setTab("email")}
          />
        </TabsContent>
        <TabsContent value="email" className="mt-6">
          <AdminEmailComposer
            selectedIds={selectedIds}
            onClearSelection={() => setSelectedIds(new Set())}
            onPickRecipients={() => setTab("users")}
            subject={subject}
            body={body}
            onSubjectChange={setSubject}
            onBodyChange={setBody}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
