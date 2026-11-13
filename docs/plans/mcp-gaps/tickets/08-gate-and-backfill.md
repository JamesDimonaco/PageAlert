# 08: Verify on the 7 PC build monitors, then backfill everyone

**What to build:** Every live monitor picks up stock-aware matching, without re-announcing old matches.

**Blocked by:** 01, 02, and the release being deployed

**Status:** code done; the prod run waits for the deploy

- [x] `backfill.snapshotMatchKeys` and `backfill.markReReadDue`, a dry run unless `dryRun: false`.
- [ ] After deploy: save the snapshot, then mark the 7 due with `checkNow: true`.
- [ ] Gate: Kingston and Noctua no longer match; the other 5 keep their matches unless sold out; no alerts sent.
- [ ] Only then: `markReReadDue` with `dryRun: false` on everything, and read every match that dropped.
- [ ] Give the 7 real stock and price alerts with `update_monitor`.

Run from `apps/web`, after `cvx personal`:

```
npx convex run --prod backfill:snapshotMatchKeys > snapshot.json
npx convex run --prod backfill:markReReadDue '{"dryRun": false, "checkNow": true, "monitorIds": [...the 7 ids...]}'
npx convex run --prod backfill:markReReadDue '{}'                 # dry run: shows the count
npx convex run --prod backfill:markReReadDue '{"dryRun": false}'
```

The 7 ids:

- `j57av7rk5z6jvbhnh34fr6g33d8j2g34` Gigabyte B650I AX
- `j570ejts3603dbnc4xbek9mqdd8j2cs8` Noctua NH-L9a-AM5
- `j578dmky89k8fymhmwe9rzdbxn8j2n89` Fractal Terra
- `j57cdhtatkpqt0wcw2yc4tzw958j20rk` PowerColor RX 9060 XT
- `j5740rxawy61xmfq7qnbhb4m8n8j2py3` Corsair SF750
- `j57fw3t5n0t5zagz8e7vxy0q498j2t41` Kingston DDR5-6000
- `j573n8rnmg53aanxx42njhz4dn8j3v4d` Ryzen 5 7600
