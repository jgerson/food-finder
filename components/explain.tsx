"use client";
// The Explain panel: how turbopuffer ran a search, or why one result ranked where it did.
import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { Hit, SearchResult } from "@/lib/search";
import { COURSE_LABELS } from "@/lib/courses";

export type QueryKind = "text" | "photo" | "similar";

const HOW: Record<QueryKind, string> = {
  text: "Your words went through CLIP's text encoder in your browser, giving a 512-number vector. Text and photos share one vector space, so turbopuffer looked for the photo vectors pointing in the most similar direction.",
  photo: "Your photo went through CLIP's image encoder in your browser, giving a 512-number vector. turbopuffer looked for the stored photo vectors pointing in the most similar direction.",
  similar: "The selected photo's stored vector was read from turbopuffer and used as the query, excluding the photo itself.",
};

/** How the whole search ran. `explainBody` is what /api/explain needs to re-run it. */
export function RunPanel({ data, kind, embedMs, explainBody }: {
  data: SearchResult; kind: QueryKind; embedMs: number | null; explainBody: Record<string, unknown>;
}) {
  const r = data.run;
  const network = r.serverMs != null ? Math.max(0, r.roundMs - r.serverMs) : null;
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-[15px] font-medium text-ink">How this search ran</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{HOW[kind]}</p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-accent-soft p-4 text-[13px]">
        {embedMs != null && <Stat label="Embedding in your browser" value={`${embedMs} ms`} />}
        <Stat label="turbopuffer server time" value={r.serverMs != null ? `${r.serverMs} ms` : "–"} />
        <Stat label="Network and overhead" value={network != null ? `${network} ms` : "–"} />
        <Stat label="Cache" value={r.cache ?? "–"} hint="hot = in memory, warm = on local SSD, cold = read from object storage" />
        <Stat label="Photos in the namespace" value={r.approxRows != null ? `~${r.approxRows.toLocaleString()}` : "–"} />
        <Stat label="Billed bytes queried" value={r.billedBytesQueried != null ? fmtBytes(r.billedBytesQueried) : "–"} />
      </dl>

      <div className="text-[13px] leading-relaxed text-ink-2">
        <p>
          Asked for the top {r.topK} by cosine distance with an approximate nearest-neighbor (ANN) index, which
          avoids comparing against every one of the stored vectors.
          {r.filters.length ? ` Filtered to: ${r.filters.join("; ")}.` : " No filters."}
        </p>
      </div>

      {data.votes.length > 0 && <Votes data={data} />}

      <details className="group">
        <summary className="cursor-pointer text-[13px] text-slate hover:text-ink">Request sent to turbopuffer</summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-accent-soft p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
          {JSON.stringify({ namespace: r.namespace, ...r.request }, null, 2)}
        </pre>
      </details>

      <PlanAndConsistency body={explainBody} />
      <p className="text-[12.5px] text-slate">Select a photo to see why it ranked where it did.</p>
    </div>
  );
}

function Votes({ data }: { data: SearchResult }) {
  const max = data.votes[0].score;
  return (
    <div>
      <h4 className="text-[13px] font-medium text-ink">How &ldquo;Looks like&rdquo; was decided</h4>
      <p className="mt-1 text-[12.5px] leading-relaxed text-slate">
        A vote among the top 10: each photo votes for its dish, worth 1 at rank 1, ½ at rank 2, ⅓ at rank 3 and so on.
      </p>
      <ul className="mt-2 space-y-1.5">
        {data.votes.slice(0, 5).map((v) => (
          <li key={v.dish} className="text-[12.5px]">
            <div className="flex justify-between gap-2">
              <span className="text-ink">{v.dish}</span>
              <span className="font-mono text-slate">{v.votes} photo{v.votes > 1 ? "s" : ""} · ranks {v.ranks.join(", ")} · {v.score.toFixed(2)}</span>
            </div>
            <div className="mt-0.5 h-1.5 rounded-full bg-accent-soft">
              <div className="h-1.5 rounded-full bg-ink" style={{ width: `${(v.score / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Explained = { plan: string; strong: Timing; eventual: Timing };
type Timing = { roundMs: number; serverMs: number | null };

/** On request: turbopuffer's query plan, and the same search timed with strong and eventual consistency. */
function PlanAndConsistency({ body }: { body: Record<string, unknown> }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [out, setOut] = useState<Explained | null>(null);
  const go = async () => {
    setState("loading");
    try {
      const r = await fetch("/api/explain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setOut(j);
      setState("idle");
    } catch {
      setState("error");
    }
  };
  if (!out) {
    return (
      <div>
        <button onClick={go} disabled={state === "loading"}
          className="inline-flex items-center gap-2 rounded-lg border border-line-2 px-3 py-1.5 text-[13px] text-ink-2 hover:border-ink disabled:opacity-60">
          {state === "loading" && <Loader2 size={14} className="animate-spin" />}
          Show the query plan and consistency timing
        </button>
        {state === "error" && <p className="mt-2 text-[12.5px] text-red-700">Couldn&apos;t get the query plan. Try again.</p>}
      </div>
    );
  }
  return (
    <div className="space-y-3 text-[13px]">
      <div>
        <h4 className="font-medium text-ink">Consistency</h4>
        <p className="mt-1 text-[12.5px] leading-relaxed text-slate">
          Strong (the default) checks object storage for the newest writes before answering; eventual skips that check
          and may miss writes from the last few seconds.
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-3 rounded-xl bg-accent-soft p-3">
          <Stat label="Strong" value={`${out.strong.roundMs} ms`} hint={out.strong.serverMs != null ? `${out.strong.serverMs} ms on the server` : undefined} />
          <Stat label="Eventual" value={`${out.eventual.roundMs} ms`} hint={out.eventual.serverMs != null ? `${out.eventual.serverMs} ms on the server` : undefined} />
        </dl>
      </div>
      <div>
        <h4 className="font-medium text-ink">Query plan</h4>
        <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-accent-soft p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">{out.plan || "(empty)"}</pre>
      </div>
    </div>
  );
}

/** Why one photo ranked where it did. */
export function HitPanel({ hit, data, kind, onMore }: { hit: Hit; data: SearchResult; kind: QueryKind; onMore: () => void }) {
  const first = data.hits[0];
  const last = data.hits.at(-1)!;
  const vote = data.votes.find((v) => v.dish === hit.dish);
  const inTop10 = hit.rank <= 10;
  const range = first.similarity - last.similarity || 1;
  return (
    <div className="space-y-5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={hit.url} alt={hit.dish} className="aspect-square w-full rounded-xl object-cover" />
      <div>
        <h3 className="font-display text-2xl text-ink">{hit.dish}</h3>
        <p className="text-[13px] text-slate">{COURSE_LABELS[hit.course]} · <span className="font-mono">{hit.id}</span></p>
      </div>
      <dl className="grid grid-cols-3 gap-3 rounded-xl bg-accent-soft p-4 text-[13px]">
        <Stat label="Rank" value={`${hit.rank} of ${data.hits.length}`} />
        <Stat label="Cosine similarity" value={hit.similarity.toFixed(3)} />
        <Stat label="Distance" value={hit.distance.toFixed(3)} hint="1 − similarity" />
      </dl>
      <div>
        <div className="flex justify-between text-[11.5px] text-slate"><span>#{data.hits.length}</span><span>#1</span></div>
        <div className="relative mt-1 h-2 rounded-full bg-accent-soft">
          <div className="absolute top-1/2 h-3.5 w-1.5 -translate-y-1/2 rounded-full bg-ink"
            style={{ left: `calc(${((hit.similarity - last.similarity) / range) * 100}% - 3px)` }} />
        </div>
        <p className="mt-1 text-[11.5px] text-slate">Where this similarity sits between the last and the top result.</p>
      </div>
      <div className="space-y-2 text-[13px] leading-relaxed text-ink-2">
        <p>
          {kind === "text"
            ? `CLIP placed this photo's vector ${hit.similarity.toFixed(3)} (cosine) from your words. Text-to-photo similarities are always low, around 0.2 to 0.35; what matters is the order, not the number.`
            : `This photo's vector is ${hit.similarity.toFixed(3)} (cosine) from the query photo. Photo-to-photo similarities run higher than text ones; 1.0 would be the same picture.`}
          {hit.rank > 1 && ` It sits ${(first.similarity - hit.similarity).toFixed(3)} below the top result.`}
        </p>
        <p>
          {inTop10
            ? `In the top 10, so it voted for ${hit.dish.toLowerCase()} with weight ${(1 / hit.rank).toFixed(2)}${vote ? ` (${hit.dish.toLowerCase()} got ${vote.votes} vote${vote.votes > 1 ? "s" : ""}, ${vote.score.toFixed(2)} in total)` : ""}.`
            : "Outside the top 10, so it didn't vote on the “Looks like” guess."}
          {data.guess && hit.dish !== data.guess.dish && inTop10 && ` The guess went to ${data.guess.dish.toLowerCase()} instead.`}
        </p>
      </div>
      <button onClick={onMore} className="rounded-lg bg-ink px-4 py-2 text-[13px] font-medium text-paper">More like this</button>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-[11.5px] text-slate">{label}</dt>
      <dd className="font-mono text-[14px] text-ink" title={hint}>{value}</dd>
      {hint && <dd className="text-[11px] leading-snug text-slate">{hint}</dd>}
    </div>
  );
}

function fmtBytes(b: number) {
  return b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(0)} KB` : `${b} B`;
}
