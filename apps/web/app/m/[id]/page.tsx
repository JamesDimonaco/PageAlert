import { redirect } from "next/navigation";

/**
 * Short link for text alerts.
 *
 * `/dashboard/monitors/<id>` is 64 characters once the host and a Convex id
 * are in it — 40% of a single SMS segment, and a second segment costs another
 * send. This trims it to 47 and redirects.
 */
export default async function MonitorShortLink({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/dashboard/monitors/${id}`);
}
