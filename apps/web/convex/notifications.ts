import { v } from "convex/values";
import { action } from "./_generated/server";

const FROM_EMAIL = "PageAlert <alerts@pagealert.io>";
const APP_URL = process.env.SITE_URL ?? "https://pagealert.io";

/** Send a test/verification email to the user */
export const sendTestEmail = action({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const email = identity.email;
    if (!email) throw new Error("No email found on your account");

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("Email service not configured");

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
      <div style="background:#4f46e5;padding:24px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600">Email Notifications Working!</h1>
      </div>
      <div style="padding:32px">
        <p style="margin:0 0 16px;color:#333;font-size:16px">
          Great news — your email notifications are set up correctly. When your monitors find matches, you'll receive alerts at <strong>${email}</strong>.
        </p>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:24px">
          <p style="margin:0;color:#166534;font-size:14px;font-weight:500">What to do next:</p>
          <ul style="margin:8px 0 0;padding-left:20px;color:#166534;font-size:14px">
            <li>If this landed in spam, mark it as "Not Spam"</li>
            <li>Add <strong>${FROM_EMAIL.match(/<(.+)>/)?.[1] ?? "alerts@pagealert.io"}</strong> to your contacts</li>
            <li>Go back to PageAlert to confirm your email is verified</li>
          </ul>
        </div>
        <a href="${APP_URL}/dashboard/settings" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px">
          Back to PageAlert
        </a>
      </div>
      <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #eee">
        <p style="margin:0;color:#999;font-size:12px">
          This is a test email from PageAlert. <a href="${APP_URL}/dashboard/settings" style="color:#999">Manage notifications</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [email],
        subject: "PageAlert — Email notifications are working!",
        html,
        text: `Email notifications are working!\n\nYour monitors will send alerts to ${email}.\n\nIf this landed in spam, mark it as "Not Spam" and add ${FROM_EMAIL} to your contacts.\n\nBack to PageAlert: ${APP_URL}/dashboard/settings`,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("[notifications] Test email failed:", res.status, body);
      throw new Error("Failed to send test email");
    }

    return { sent: true, to: email };
  },
});
