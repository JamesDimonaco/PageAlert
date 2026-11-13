# PageAlert

PageAlert watches web pages for a user and alerts them when something they asked for appears.

## Watching

**Monitor**:
One page PageAlert checks on a schedule, with the user's prompt.
_Avoid_: Watcher, tracker, alert

**Prompt**:
What the user wants from the page, in their own words.
_Avoid_: Query, rule

**First scan**:
The full read of a page when its monitor is created. The user watches it finish.
_Avoid_: Initial check, preview

**Preview**:
A one-off read of a page that saves nothing. Agents use it before creating a monitor.
_Avoid_: Test scan, dry run

**Product**:
One item for sale, watched at several shops. Each shop's page is its own monitor inside the product.
_Avoid_: Group, monitor group

**Product page**:
A shop's page for one item. Other items on it, such as a related-products row, are not the product.
_Avoid_: Single-item page, detail page

**Folder**:
A name the user gives to a set of monitors and products, such as "PC build". It holds no settings.
_Avoid_: Group, collection, project

## Alerts

**Match**:
An item on the page that meets every condition read from the prompt.
_Avoid_: Hit, result

**Match alert**:
An alert sent when a match is new since the last check.
_Avoid_: Notification

**Stock alert**:
An alert sent when a product goes from out of stock to in stock.
_Avoid_: Restock notification

**Price alert**:
An alert sent when a product's price drops, or falls below the user's target.
_Avoid_: Deal alert
