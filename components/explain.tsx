"use client";
// The Explain panel: how turbopuffer ran a search, or why one result ranked where it did.
import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { Hit, Mode, SearchResult } from "@/lib/search";
import { COURSE_LABELS } from "@/lib/courses";

export type QueryKind = "text" | "photo" | "similar";

const HOW_VECTOR: Record<QueryKind, string> = {
  text: "Your words went through CLIP's text encoder in your browser, giving a 512-number vector. Text and photos share one vector space, so turbopuffer found the photo vectors pointing in the most similar direction.",
  photo: "Your photo went through CLIP's image encoder in your browser, giving a 512-number vector. turbopuffer found the stored photo vectors pointing in the most similar direction. Photo searches are vector-only: there's no text to match.",
  similar: "The selected photo's stored vector was read from turbopuffer and used as the query, excluding the photo itself. Vector-only: there's no text to match.",
};
const HOW_MODE: Record<Mode, string> = {
  vector: "",
  keyword: "Keyword (BM25) search: turbopuffer matched your words against each photo's keywords (the dish name plus a caption Claude Haiku wrote for every photo). Rare words count more than common ones, and repeats help less each time. No vectors involved.",
  hybrid: "Hybrid: one multi_query ran the vector search and a BM25 keyword search over each photo's caption keywords side by side. The two lists were then fused with reciprocal rank fusion: each photo scores 1/(60 + rank) for every list it's in, so photos near the top of both rise.",
};

/** How the whole search ran. `explainBody` is what /api/explain needs to re-run it. */
export function RunPanel({ data, kind, embedMs, explainBody }: {
  data: SearchResult; kind: QueryKind; embedMs: number | null; explainBody: Record<string, unknown>;
}) {
  const r = data.run;
  const network = r.serverMs != null ? Math.max(0, r.roundMs - r.serverMs) : null;
  const both = data.hits.filter((h) => h.vector && h.bm25).length;
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-[15px] font-medium text-ink">How this search ran <span className="ml-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] font-normal text-ink-2">{MODE_LABEL[r.mode]}</span></h3>
        {r.mode !== "keyword" && <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{HOW_VECTOR[kind]}</p>}
        {r.mode !== "vector" && <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{HOW_MODE[r.mode]}</p>}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-accent-soft p-4 text-[13px]">
        {embedMs != null && r.mode !== "keyword" && <Stat label="Embedding in your browser" value={`${embedMs} ms`} />}
        <Stat label="turbopuffer server time" value={r.serverMs != null ? `${r.serverMs} ms` : "–"} />
        <Stat label="Network and overhead" value={network != null ? `${network} ms` : "–"} />
        <Stat label="Cache" value={r.cache ?? "–"} hint="hot = in memory, warm = on local SSD, cold = read from object storage" />
        <Stat label="Photos in the namespace" value={r.approxRows != null ? `~${r.approxRows.toLocaleString()}` : "–"} />
        <Stat label="Billed bytes queried" value={r.billedBytesQueried != null ? fmtBytes(r.billedBytesQueried) : "–"} />
        {r.mode === "hybrid" && <Stat label="In both lists" value={`${both} of ${data.hits.length}`} hint={`each list returned up to ${r.candidates}`} />}
      </dl>

      <p className="text-[13px] leading-relaxed text-ink-2">
        {r.mode === "vector" && `Asked for the top ${r.topK} by cosine distance as an approximate nearest-neighbor (ANN) query. Once turbopuffer has built its vector index, that avoids comparing against every stored vector.`}
        {r.mode === "keyword" && `Asked for the top ${r.topK} by BM25 score over the keywords field.`}
        {r.mode === "hybrid" && `Each list asked for its top ${r.candidates} (vector returned ${r.listSizes.vector ?? 0}, keyword ${r.listSizes.keyword ?? 0}); the fused list keeps the top ${r.topK}.`}
        {data.terms.length > 0 && r.mode !== "vector" && ` Words searched: ${data.terms.join(", ")}.`}
        {r.filters.length ? ` Filtered to: ${r.filters.join("; ")}.` : " No filters."}
      </p>

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

export const MODE_LABEL: Record<Mode, string> = { hybrid: "Hybrid", vector: "Vector", keyword: "Keyword" };

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

type Explained = { plans: { label: string; plan: string | null; note: string | null }[]; strong: Timing; eventual: Timing };
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
      {out.plans.map((p) => (
        <div key={p.label}>
          <h4 className="font-medium text-ink">Query plan{out.plans.length > 1 ? `: ${p.label}` : ""}</h4>
          {p.plan != null
            ? <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-accent-soft p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">{p.plan || "(empty)"}</pre>
            : <p className="mt-1 text-[12.5px] leading-relaxed text-slate">{p.note}</p>}
        </div>
      ))}
    </div>
  );
}

/** Why one photo ranked where it did. */
export function HitPanel({ hit, data, kind, onMore }: { hit: Hit; data: SearchResult; kind: QueryKind; onMore: () => void }) {
  const mode = data.run.mode;
  const vote = data.votes.find((v) => v.dish === hit.dish);
  const inTop10 = hit.rank <= 10;
  return (
    <div className="space-y-5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={hit.url} alt={hit.dish} className="aspect-square w-full rounded-xl object-cover" />
      <div>
        <h3 className="font-display text-2xl text-ink">{hit.dish}</h3>
        <p className="text-[13px] text-slate">{COURSE_LABELS[hit.course]} · <span className="font-mono">{hit.id}</span></p>
        {hit.caption && <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{hit.caption}</p>}
      </div>

      <dl className="grid grid-cols-3 gap-3 rounded-xl bg-accent-soft p-4 text-[13px]">
        <Stat label={`${MODE_LABEL[mode]} rank`} value={`${hit.rank} of ${data.hits.length}`} />
        {mode !== "keyword" && <Stat label="Vector rank" value={hit.vector ? `#${hit.vector.rank}` : "not in list"}
          hint={hit.vector ? `similarity ${hit.vector.similarity.toFixed(3)}` : `outside the vector top ${data.run.candidates}`} />}
        {mode !== "vector" && <Stat label="Keyword rank" value={hit.bm25 ? `#${hit.bm25.rank}` : "not in list"}
          hint={hit.bm25 ? `BM25 ${hit.bm25.score.toFixed(2)}` : "no query words in its keywords"} />}
        {mode === "hybrid" && hit.fused != null && <Stat label="Fused (RRF)" value={hit.fused.toFixed(4)}
          hint={[hit.vector && `1/(60+${hit.vector.rank})`, hit.bm25 && `1/(60+${hit.bm25.rank})`].filter(Boolean).join(" + ")} />}
      </dl>

      <div className="space-y-2 text-[13px] leading-relaxed text-ink-2">
        {hit.vector && mode !== "keyword" && <p>
          {kind === "text"
            ? `CLIP placed this photo's vector ${hit.vector.similarity.toFixed(3)} (cosine) from your words. Text-to-photo similarities are always low, around 0.2 to 0.35; the order matters, not the number.`
            : `This photo's vector is ${hit.vector.similarity.toFixed(3)} (cosine) from the query photo. Photo-to-photo similarities run higher than text ones; 1.0 would be the same picture.`}
        </p>}
        {mode !== "vector" && (hit.bm25
          ? <p>Its keywords contain {hit.terms.length ? hit.terms.map((t) => `“${t}”`).join(", ") : "your words (as turbopuffer tokenizes them)"}, which gave a BM25 score of {hit.bm25.score.toFixed(2)}, #{hit.bm25.rank} among keyword matches.</p>
          : <p>None of your words appear in its keywords, so it ranked on {mode === "hybrid" ? "the vector list alone" : "nothing"}.</p>)}
        {mode === "hybrid" && hit.vector && hit.bm25 && <p>It's in both lists, which is what lifts a photo in hybrid search.</p>}
        <p>
          {inTop10
            ? `In the top 10, so it voted for ${hit.dish.toLowerCase()} with weight ${(1 / hit.rank).toFixed(2)}${vote ? ` (${hit.dish.toLowerCase()} got ${vote.votes} vote${vote.votes > 1 ? "s" : ""}, ${vote.score.toFixed(2)} in total)` : ""}.`
            : "Outside the top 10, so it didn't vote on the “Looks like” guess."}
          {data.guess && hit.dish !== data.guess.dish && inTop10 && ` The guess went to ${data.guess.dish.toLowerCase()} instead.`}
        </p>
      </div>

      {hit.keywords && mode !== "vector" && (
        <div>
          <h4 className="text-[13px] font-medium text-ink">Keywords BM25 searched</h4>
          <p className="mt-1 rounded-lg bg-accent-soft p-3 text-[12.5px] leading-relaxed text-ink-2">
            <Highlight text={hit.keywords} terms={hit.terms} />
          </p>
          <p className="mt-1 text-[11.5px] text-slate">Written by Claude Haiku 5.5 from the photo; it can be wrong.</p>
        </div>
      )}
      <button onClick={onMore} className="rounded-lg bg-ink px-4 py-2 text-[13px] font-medium text-paper">More like this</button>
    </div>
  );
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`\\b(${terms.map((t) => t.replace(/[-]/g, "\\-")).join("|")})[a-z]*`, "gi");
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(text.slice(last, m.index));
    parts.push(<mark key={m.index} className="rounded bg-[#f3e2a9] px-0.5 text-ink">{m[0]}</mark>);
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
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
