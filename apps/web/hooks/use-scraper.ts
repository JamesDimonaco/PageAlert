"use client";

import { useState, useRef, useCallback } from "react";
import type { ExtractionSchema, ExtractedItem } from "@prowl/shared";

interface ExtractResult {
  url: string;
  schema: ExtractionSchema;
  matches: ExtractedItem[];
  totalItems: number;
  scrapedAt: string;
}

export function useScraper() {
  const [data, setData] = useState<ExtractResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const extract = useCallback(async (url: string, prompt: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);
    setData(null);

    try {
      const res = await fetch("/api/scraper/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, prompt }),
        signal: controller.signal,
      });

      const json = await res.json();

      if (!res.ok) {
        throw new Error(json.error || json.message || "Extraction failed");
      }

      setData(json);
      return json as ExtractResult;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return null;
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setError(msg);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setIsLoading(false);
  }, []);

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setIsLoading(false);
  }, []);

  return { data, isLoading, error, extract, cancel, reset };
}
