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
  metadataBase: new URL("https://pagealert.io"),
  title: "PageAlert - AI-Powered Web Monitor",
  description: "Monitor any website with natural language. Get notified the moment anything changes.",
  openGraph: {
    title: "PageAlert - AI-Powered Web Monitor",
    description: "Monitor any website with natural language. Get notified the moment anything changes.",
    url: "https://pagealert.io",
    siteName: "PageAlert",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "PageAlert - AI-Powered Web Monitor",
    description: "Monitor any website with natural language. Get notified the moment anything changes.",
  },
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
