# 07: get_recent_matches(since)

**What to build:** New matches across all of a user's monitors in one call.

**Blocked by:** 03

**Status:** done

- [x] Picks monitors by lastMatchAt, up to 50. Dates each item from the first row it appeared in. Leaves out Product listings.
- [x] Answer capped like get_matches (20 by default, 100 at most).
