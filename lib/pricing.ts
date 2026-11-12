// Per-token list prices from AI Gateway's public model list, for the cost shown under each copilot answer.
// Prompt-cache reads and writes are priced separately when the list has them (otherwise at Anthropic's standard
// 0.1x and 1.25x of the input price). It's still an estimate: provider-specific pricing isn't modeled.
import "server-only";

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };
let cache: { at: number; prices: Map<string, Price> } | null = null;
const DAY = 24 * 60 * 60 * 1000;

async function prices(): Promise<Map<string, Price>> {
  if (cache && Date.now() - cache.at < DAY) return cache.prices;
  const res = await fetch("https://ai-gateway.vercel.sh/v1/models", { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`models list ${res.status}`);
  const { data } = (await res.json()) as {
    data: { id: string; pricing?: { input?: string; output?: string; input_cache_read?: string; input_cache_write?: string } }[];
  };
  const map = new Map<string, Price>();
  for (const m of data) {
    const input = Number(m.pricing?.input), output = Number(m.pricing?.output);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    const read = Number(m.pricing?.input_cache_read), write = Number(m.pricing?.input_cache_write);
    map.set(m.id, { input, output, cacheRead: Number.isFinite(read) ? read : input * 0.1,
      cacheWrite: Number.isFinite(write) ? write : input * 1.25 });
  }
  cache = { at: Date.now(), prices: map };
  return map;
}

/** Dollars per input and output token on `model`, or null when the model isn't an AI Gateway id or the list is unreachable. */
export async function priceOf(model: string): Promise<Price | null> {
  if (!model.includes("/")) return null; // a direct Anthropic model id, not priced through the gateway
  try {
    return (await prices()).get(model) ?? null;
  } catch {
    return null;
  }
}

/** Token counts for pricing. `input` is uncached input only, as the API reports it. */
export type TokenCounts = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

/** Dollars for these tokens at price `p`, split by kind. */
export function priced(p: Price, t: TokenCounts) {
  const parts = { input: t.input * p.input, output: t.output * p.output,
    input_cache_read: (t.cacheRead ?? 0) * p.cacheRead, input_cache_creation: (t.cacheWrite ?? 0) * p.cacheWrite };
  return { ...parts, total: parts.input + parts.output + parts.input_cache_read + parts.input_cache_creation };
}

/** Dollars for this many tokens on `model`, or null when the price is unknown. */
export async function costOf(model: string, inTokens: number, outTokens: number, cacheRead = 0, cacheWrite = 0): Promise<number | null> {
  const p = await priceOf(model);
  return p ? priced(p, { input: inTokens, output: outTokens, cacheRead, cacheWrite }).total : null;
}
