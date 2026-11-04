# 03: Beta features setting

**What to build:** A Beta features section in Settings with one toggle, "Find a product", off by default. A signed-in user can turn it on and off, and the server can read it. This is how the feature rolls out: James turns it on first, then friends who help test, then anyone who wants to try it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Settings shows a "Beta features" section with a "Find a product" toggle and one line explaining it's an early version.
- [ ] The choice is saved per user and survives sign-out and sign-in.
- [ ] A server-side helper answers "does this user have Find a product on?" Ticket 06 uses it to refuse searches.
- [ ] Off by default for every existing and new user.
- [ ] Toggling sends a PostHog event with the feature name and the new state.
