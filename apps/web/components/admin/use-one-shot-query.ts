"use client";

import { useCallback, useEffect, useState } from "react";
import { useConvex } from "convex/react";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";

/**
 * Runs a Convex query once (on mount, and again on `refresh()`) instead of
 * subscribing reactively. For heavy admin queries that shouldn't re-run on
 * every scrape write, but still need a manual way to pick up recent changes.
 */
export function useOneShotQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query>,
) {
  const convex = useConvex();
  const [data, setData] = useState<FunctionReturnType<Query> | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  // `api.x.y` is a fresh proxy on every render; the name is the stable identity
  const queryName = getFunctionName(query);
  // Args are usually a fresh `{}` literal each render, so they cannot go in the
  // dep array directly. Serialising them means a caller that varies its args
  // (a filter, a limit) actually refetches, while the constant-`{}` callers
  // keep the same key and are unaffected.
  const argsKey = JSON.stringify(args);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const result = await convex.query(query, args);
        if (!cancelled) setData(result);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
    // query/args intentionally excluded in favour of queryName/argsKey, which
    // are their stable identities; refresh() bumps nonce to force a re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convex, queryName, argsKey, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, refresh };
}
