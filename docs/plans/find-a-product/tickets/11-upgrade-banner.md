# 11: Quiet upgrade banner at the limit

**What to build:** When a user has used every monitor slot on their plan, a small banner at the top of the dashboard suggests upgrading for more. It never blocks anything. It shows up at the moment they want more listings, which is the most natural upgrade point.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] The banner shows when the user is at their monitor limit, on the dashboard and the product view.
- [ ] It names the next plan's limit and links to pricing.
- [ ] It can be dismissed, and it stays hidden for a sensible period (such as 7 days) before showing again.
- [ ] It never stops any action. Limits are still enforced as they are today.
- [ ] `upgrade_banner_shown` fires once per showing, and `upgrade_banner_clicked` on click.
