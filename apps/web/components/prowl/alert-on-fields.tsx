"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { currencyExponent, fromMinorUnits, toMinorUnits } from "@prowl/shared";
import type { AlertOn } from "@/convex/schema";

export type PriceChoice = "off" | "drop" | "below";
const CURRENCIES = Intl.supportedValuesOf("currency");

type FieldValues = { backInStock: boolean; priceChoice: PriceChoice; target: string; currency: string };

/** What the fields ask for, or what to fix first. Options left off are omitted, not sent as false. */
export function alertOnFromFields({ backInStock, priceChoice, target, currency }: FieldValues):
  | { alertOn: AlertOn; error?: undefined }
  | { error: string } {
  const amount = priceChoice === "below" ? toMinorUnits(Number(target), currency) : null;
  if (priceChoice === "below" && !amount) {
    return { error: currency ? "Enter a target price above zero." : "Pick the currency of your target price." };
  }
  return {
    alertOn: {
      ...(backInStock ? { backInStock: true } : {}),
      ...(priceChoice === "drop" ? { priceDrop: true } : {}),
      ...(amount ? { priceBelow: { amount, currency } } : {}),
    },
  };
}

/** A saved target as the target field shows it. */
export function targetText(priceBelow: AlertOn["priceBelow"]): string {
  const amount = priceBelow ? fromMinorUnits(priceBelow.amount, priceBelow.currency) : null;
  return amount === null ? "" : String(amount);
}

interface AlertOnFieldsProps {
  backInStock: boolean;
  onBackInStockChange: (on: boolean) => void;
  priceChoice: PriceChoice;
  onPriceChoiceChange: (choice: PriceChoice) => void;
  /** The target as typed, in major units. */
  target: string;
  onTargetChange: (target: string) => void;
  currency: string;
  onCurrencyChange: (currency: string) => void;
}

/** Back in stock, plus one price choice: off, any drop, or below a target. */
export function AlertOnFields({
  backInStock,
  onBackInStockChange,
  priceChoice,
  onPriceChoiceChange,
  target,
  onTargetChange,
  currency,
  onCurrencyChange,
}: AlertOnFieldsProps) {
  const radioName = useId();
  const exponent = currencyExponent(currency) ?? 2;
  return (
    <>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={backInStock}
          onChange={(e) => onBackInStockChange(e.target.checked)}
          className="rounded border-border accent-primary h-4 w-4 shrink-0"
        />
        <span className="text-sm">Tell me when it&apos;s back in stock</span>
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Price alerts</legend>
        {([
          ["off", "Off"],
          ["drop", "Tell me about any price drop"],
          ["below", "Only tell me when it's below a price"],
        ] as const).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name={radioName}
              checked={priceChoice === value}
              onChange={() => onPriceChoiceChange(value)}
              className="border-border accent-primary h-4 w-4 shrink-0"
            />
            <span className="text-sm">{label}</span>
          </label>
        ))}
        {priceChoice === "below" && (
          <div className="flex items-center gap-2 pl-6">
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step={exponent === 0 ? 1 : 1 / 10 ** exponent}
              value={target}
              onChange={(e) => onTargetChange(e.target.value)}
              className="w-32"
              aria-label={`Target price in ${currency}`}
            />
            <select
              value={currency}
              onChange={(e) => onCurrencyChange(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
              aria-label="Currency of the target price"
            >
              <option value="" disabled>Currency</option>
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>{code}</option>
              ))}
            </select>
          </div>
        )}
      </fieldset>
    </>
  );
}
