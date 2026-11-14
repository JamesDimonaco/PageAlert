# 01: Sold-out items never match when the prompt asks for stock

**What to build:** When a prompt asks for stock, a sold-out item is not a match on the first scan or on any check, and its restock alerts. When the page does not show stock, the item can match and the user sees "Stock not shown on page".

**Blocked by:** None (can start immediately)

**Status:** done

- [x] The extractor returns `inStock: true | false | null` per item and sets `inStockOnly` when the prompt asks for stock. Backorder and pre-order count as false.
- [x] `explainMatch` adds a stock check: false fails, true passes, null passes and is marked not shown.
- [x] Quick checks score with the stock read when stock is asked for. A sold-out entry never alerts. Up to 5 sold-out entries are judged again per check, in turn, so a restock alerts.
- [x] The match checks panel shows a stock row. Match alerts name items whose stock was not shown.
- [x] Real-API run on the 7 "PC build" pages: Kingston and Noctua read as sold out and no longer match.
