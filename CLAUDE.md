<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->

- PostHog project id: 354294 (personal account — query via `phog personal`).

## Conventions

- **Branch off `main`, PR into `main`.** There is no `staging` branch in this repo.
- Branch naming is `type/slug`, with the ticket number where one exists: `feat/042-mcp-server`,
  `fix/scraper-block-detection`, `chore/weekly-deps-2026-09-28`.
- Ticket prefix is `PROWL-0xx`, used in PR titles (e.g. `feat(mcp): let agents create and read
  monitors over MCP (PROWL-042)`).
