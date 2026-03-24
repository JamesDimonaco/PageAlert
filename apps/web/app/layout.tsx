import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ConvexClientProvider } from "@/components/convex-provider";
import { PostHogProvider } from "@/components/posthog-provider";
import { getToken } from "@/lib/auth-server";
import { Suspense } from "react";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Prowl - AI-Powered Web Monitor",
  description: "Monitor any website with natural language. Get notified when things change.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const token = await getToken();

  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col">
        <Suspense fallback={null}>
          <PostHogProvider>
            <ConvexClientProvider initialToken={token}>
              {children}
            </ConvexClientProvider>
          </PostHogProvider>
        </Suspense>
        <Toaster />
      </body>
    </html>
  );
}
