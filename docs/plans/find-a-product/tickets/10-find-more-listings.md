# 10: Find more listings

**What to build:** On the product view, a "Find more listings" button runs the search again for the same product and region. New listings are added as suggestions, and ones already in the product are skipped.

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] The button runs the same search as ticket 06 and counts toward the daily limit, with the same rule that failures don't count.
- [ ] Results whose URL is already in the product, in any state, are skipped. Different URLs on the same site can be added.
- [ ] New results are added as `suggested` and highlighted as new.
- [ ] When nothing new is found, the user is told so.
- [ ] `find_more_listings_clicked` fires, with the count of new listings.
