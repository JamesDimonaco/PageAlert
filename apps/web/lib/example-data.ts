export interface ExampleItem {
  title: string;
  price: number;
  matched: boolean;
  oldPrice?: number;
}

export const EXAMPLE_ITEMS: ExampleItem[] = [
  { title: "MacBook Pro 14\" M3 Pro 18GB — Refurbished", price: 1399, matched: true, oldPrice: 1549 },
  { title: "MacBook Pro 14\" M3 8GB — Refurbished", price: 1099, matched: true },
  { title: "MacBook Pro 14\" M3 Pro 36GB — Refurbished", price: 1479, matched: true, oldPrice: 1599 },
  { title: "MacBook Pro 16\" M3 Pro 18GB — Refurbished", price: 1849, matched: false },
  { title: "MacBook Pro 16\" M3 Max 36GB — Refurbished", price: 2349, matched: false, oldPrice: 2499 },
  { title: "MacBook Pro 14\" M3 Pro 18GB Space Black — Refurbished", price: 1449, matched: true, oldPrice: 1549 },
  { title: "MacBook Pro 16\" M3 Pro 36GB — Refurbished", price: 2149, matched: false },
];

export const EXAMPLE_MATCHES = EXAMPLE_ITEMS.filter((i) => i.matched).length;
export const EXAMPLE_PRICE_DROPS = EXAMPLE_ITEMS.filter((i) => i.oldPrice && i.price < i.oldPrice).length;

export const EXAMPLE_HISTORY = [
  { time: "2 hours ago", event: "Price drop detected", detail: "MacBook Pro 14\" M3 Pro dropped from $1,549 to $1,399", type: "price" as const },
  { time: "6 hours ago", event: `${EXAMPLE_MATCHES} matches found`, detail: `${EXAMPLE_MATCHES} items match your criteria`, type: "match" as const },
  { time: "12 hours ago", event: "New item added", detail: "MacBook Pro 14\" M3 Pro Space Black now available", type: "new" as const },
  { time: "1 day ago", event: "Routine check", detail: `${EXAMPLE_ITEMS.length} items scanned, ${EXAMPLE_MATCHES} matches`, type: "check" as const },
  { time: "2 days ago", event: "Price drop detected", detail: "MacBook Pro 16\" M3 Max dropped from $2,499 to $2,349", type: "price" as const },
];
