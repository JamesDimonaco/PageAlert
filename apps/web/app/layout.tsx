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

const SITE_URL = "https://pagealert.io";
const SITE_NAME = "PageAlert";
const DESCRIPTION = "Monitor any website with AI. Describe what you're looking for in plain English — get notified instantly when it appears. Track prices, stock availability, new listings, and more.";
const SHORT_DESCRIPTION = "AI-powered website monitoring. Describe what you want, get notified when it appears.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — AI-Powered Website Monitoring & Alerts`,
    template: `%s | ${SITE_NAME}`,
  },
  description: DESCRIPTION,
  keywords: [
    "website monitoring",
    "web page monitor",
    "price tracking",
    "stock alert",
    "in-stock notification",
    "price drop alert",
    "web scraping",
    "AI monitoring",
    "page change detection",
    "website change alert",
    "product availability tracker",
    "restock alert",
    "price watch",
    "web alert tool",
    "automated website checker",
    "natural language web monitor",
    "page alert",
    "pagealert",
  ],
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  applicationName: SITE_NAME,
  category: "Technology",
  classification: "Web Monitoring Tool",
  referrer: "origin-when-cross-origin",
  formatDetection: {
    email: false,
    telephone: false,
    address: false,
  },
  openGraph: {
    title: `${SITE_NAME} — AI-Powered Website Monitoring & Alerts`,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: SITE_NAME,
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} — AI-Powered Website Monitoring`,
    description: SHORT_DESCRIPTION,
    creator: "@pagealert",
    site: "@pagealert",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  alternates: {
    canonical: SITE_URL,
  },
  other: {
    "google-site-verification": "", // Add when you set up Google Search Console
  },
};

// JSON-LD structured data for rich search results
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  url: SITE_URL,
  description: DESCRIPTION,
  applicationCategory: "WebApplication",
  operatingSystem: "Any",
  offers: [
    {
      "@type": "Offer",
      name: "Free",
      price: "0",
      priceCurrency: "USD",
      description: "3 monitors, 6 hour check interval, email notifications",
    },
    {
      "@type": "Offer",
      name: "Pro",
      price: "9",
      priceCurrency: "USD",
      description: "25 monitors, 15 minute checks, all notification channels",
    },
    {
      "@type": "Offer",
      name: "Business",
      price: "29",
      priceCurrency: "USD",
      description: "Unlimited monitors, 5 minute checks, API access, webhooks",
    },
  ],
  featureList: [
    "AI-powered web page monitoring",
    "Natural language search — describe what you want",
    "Price tracking and drop alerts",
    "Stock availability notifications",
    "Email, Telegram, and Discord notifications",
    "Visual change detection",
    "Works with any website",
  ],
  screenshot: `${SITE_URL}/logo.svg`,
};

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "How does PageAlert work?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Paste a URL, describe what you're looking for in plain English, and PageAlert uses AI to understand the page, extract products and data, and monitor it automatically. You get notified via email when your conditions are met.",
      },
    },
    {
      "@type": "Question",
      name: "What kind of websites can I monitor?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Any website — product pages, stock listings, job boards, classified ads, real estate, auction sites, and more. If it's on the web and has data you care about, PageAlert can watch it.",
      },
    },
    {
      "@type": "Question",
      name: "Do I need to know CSS selectors or coding?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "No. Unlike traditional web monitoring tools, PageAlert uses AI to understand pages. Just describe what you want in plain English — no CSS selectors, XPath, or code required.",
      },
    },
    {
      "@type": "Question",
      name: "How often does PageAlert check my pages?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Check frequency depends on your plan. Free accounts check every 6 hours, Pro every 15 minutes, and Business every 5 minutes.",
      },
    },
    {
      "@type": "Question",
      name: "Is there a free plan?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes! The free plan includes 3 monitors with 6-hour check intervals and email notifications. No credit card required to get started.",
      },
    },
  ],
};

const orgJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/logo.svg`,
  sameAs: [],
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
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
      </head>
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
