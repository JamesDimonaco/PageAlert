# PageAlert

**AI-powered website monitoring. Describe what you want, get notified when it appears.**

[pagealert.io](https://pagealert.io)

---

## What is PageAlert?

PageAlert monitors any website using AI. Paste a URL, describe what you're looking for in plain English, and get notified via email when your conditions are met.

- Track product availability and restocks
- Monitor price drops across any store
- Watch for new listings on job boards, classifieds, or auction sites
- No CSS selectors or code required — just describe what you want

## How it works

1. **Paste a URL** — any website with products, listings, or data you care about
2. **Describe what you want** — "MacBook Pro M4 Max under $3000 in black"
3. **AI extracts the data** — understands the page structure, finds items, generates match filters
4. **Get notified** — email alerts when your conditions are met, with direct links to matched items

## Tech Stack

- **Frontend**: [Next.js](https://nextjs.org) (App Router) + [Tailwind CSS](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com)
- **Backend**: [Convex](https://convex.dev) (real-time database + scheduled functions)
- **Auth**: [Better Auth](https://better-auth.com) with Google/GitHub OAuth
- **Scraper**: [Playwright](https://playwright.dev) + [Hono](https://hono.dev) API (Dockerised)
- **AI**: [Anthropic Claude](https://anthropic.com) for intelligent data extraction
- **Billing**: [Polar](https://polar.sh) for subscriptions
- **Email**: [Resend](https://resend.com) for notifications
- **Analytics**: [PostHog](https://posthog.com) for product analytics + LLM observability
- **Hosting**: [Vercel](https://vercel.com) (web) + [Railway](https://railway.app) (scraper)

## Project Structure

```
prowl/
├── apps/
│   ├── web/              # Next.js app (frontend + Convex backend)
│   │   ├── app/          # Pages and routes
│   │   ├── components/   # UI components
│   │   ├── convex/       # Convex schema, mutations, queries, crons
│   │   ├── hooks/        # React hooks
│   │   └── lib/          # Utilities
│   └── scraper/          # Hono API + Playwright scraper (Docker)
│       └── src/
│           ├── routes/   # API endpoints
│           ├── services/ # Scraper + AI extractor
│           └── utils/    # URL validation, etc.
├── packages/
│   └── shared/           # Shared types and utilities
├── Dockerfile.scraper    # Docker build for scraper
├── docker-compose.yml    # Local development
└── turbo.json            # Turborepo config
```

## Development

```bash
# Install dependencies
pnpm install

# Start the web app (port 3000)
cd apps/web && pnpm dev

# Start the scraper (port 3001) — needs Playwright browsers
cd apps/scraper && pnpm dev

# Or run both via Turborepo
pnpm dev
```

### Environment Variables

Copy `.env.example` and fill in your values. See the [infrastructure doc](https://github.com/JamesDimonaco/prowl/blob/main/apps/web/.env.example) for details.

## Features

- **AI-powered extraction** — Claude understands page structure and extracts structured data
- **Smart matching** — keyword filters, price ranges, blacklists
- **Scheduled monitoring** — automatic checks from every 5 minutes to every 24 hours
- **Email notifications** — match alerts and error notifications via Resend
- **Change detection** — tracks new items, removed items, and price changes between scans
- **AI insights** — confidence scores, match signals, and page accessibility notices
- **Debug logs** — full scrape history with raw AI responses for troubleshooting
- **Multi-currency** — detects and displays prices in the correct currency
- **Subscription billing** — Free, Pro, and Max tiers via Polar

## License

Private — All rights reserved.

## Author

Built by [James DiMonaco](https://james.dimonaco.co.uk)
