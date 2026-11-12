"use client";
import { UserButton } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { COURSES, COURSE_LABELS, type Course } from "@/lib/courses";
import { useClip } from "@/lib/use-clip";
import type { SearchResult } from "@/lib/search";

type Query =
  | { kind: "text"; text: string; vector: number[] }
  | { kind: "image"; preview: string; vector: number[] }
  | { kind: "similar"; id: string; dish: string; url: string };

const EXAMPLES = ["crispy fried noodles", "chocolate dessert with berries", "something green and leafy", "raw fish on rice", "cheesy and melted"];

export default function FoodFinder() {
  const { state: model, embedText, embedImage } = useClip();
  const [text, setText] = useState("");
  const [course, setCourse] = useState<Course | null>(null);
  const [query, setQuery] = useState<Query | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [embedMs, setEmbedMs] = useState<number | null>(null);
  const [busy, setBusy] = useState<"embedding" | "searching" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const run = useCallback(async (q: Query, c: Course | null) => {
    setBusy("searching");
    setError(null);
    try {
      const body = q.kind === "similar" ? { id: q.id, course: c } : { vector: q.vector, course: c };
      const res = await fetch("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Search failed (${res.status})`);
      setResult(data);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const searchText = useCallback(async (t: string) => {
    const q = t.trim();
    if (!q) { setError("Type something to search for first."); return; }
    setError(null);
    setBusy("embedding");
    try {
      const { vector, ms } = await embedText(q);
      setEmbedMs(ms);
      const next: Query = { kind: "text", text: q, vector };
      setQuery(next);
      await run(next, course);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }, [embedText, run, course]);

  const searchImage = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) { setError("That file isn't an image."); return; }
    setError(null);
    setBusy("embedding");
    try {
      const { vector, ms } = await embedImage(file);
      setEmbedMs(ms);
      const next: Query = { kind: "image", preview: URL.createObjectURL(file), vector };
      setQuery((prev) => { if (prev?.kind === "image") URL.revokeObjectURL(prev.preview); return next; });
      setText("");
      await run(next, course);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }, [embedImage, run, course]);

  const moreLikeThis = (id: string, dish: string, url: string) => {
    const next: Query = { kind: "similar", id, dish, url };
    setQuery(next);
    setEmbedMs(null);
    void run(next, course);
  };

  const pickCourse = (c: Course | null) => {
    setCourse(c);
    if (query) void run(query, c); // same query, new filter: no re-embedding needed
  };

  // Paste an image anywhere on the page to search with it.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) { e.preventDefault(); void searchImage(file); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [searchImage]);

  const onSubmit = (e: FormEvent) => { e.preventDefault(); void searchText(text); };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void searchImage(file);
  };

  return (
    <main className="mx-auto max-w-6xl px-5 pb-16 pt-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-5xl leading-none text-ink">Food Finder</h1>
          <p className="mt-3 max-w-xl text-slate">
            Describe a dish or drop in a photo. Your browser turns it into a CLIP vector and turbopuffer finds the
            closest photos among Food-101's 101 dishes.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ModelBadge model={model} />
          <UserButton />
        </div>
      </header>

      <section className="mt-8 grid gap-3 md:grid-cols-[1fr_auto]">
        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            value={text}
            onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
            placeholder="e.g. crispy fried noodles"
            aria-label="Describe a dish"
            className="min-w-0 flex-1 rounded-lg border border-line-2 bg-surface px-4 py-3 text-ink outline-none focus:border-ink"
          />
          <button type="submit" disabled={busy !== null} className="rounded-lg bg-ink px-5 py-3 font-medium text-paper disabled:opacity-50">
            Search
          </button>
        </form>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInput.current?.click(); }}
          className={`flex cursor-pointer items-center justify-center rounded-lg border border-dashed px-5 py-3 text-sm transition-colors ${dragging ? "border-ink bg-accent-soft text-ink" : "border-line-2 text-slate hover:border-ink hover:text-ink"}`}
        >
          Drop, paste or choose a photo
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void searchImage(f); e.target.value = ""; }}
          />
        </div>
      </section>

      <nav className="mt-4 flex flex-wrap gap-2" aria-label="Filter by course">
        <Chip active={course === null} onClick={() => pickCourse(null)}>All</Chip>
        {COURSES.map((c) => (
          <Chip key={c} active={course === c} onClick={() => pickCourse(c)}>{COURSE_LABELS[c]}</Chip>
        ))}
      </nav>

      {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}

      {!query && !busy && (
        <section className="mt-10">
          <p className="text-sm text-slate">Try one of these:</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button key={ex} onClick={() => { setText(ex); void searchText(ex); }} className="rounded-full border border-line px-3 py-1.5 text-sm text-ink-2 hover:border-ink">
                {ex}
              </button>
            ))}
          </div>
        </section>
      )}

      {(query || busy) && (
        <section className="mt-8">
          <QuerySummary query={query} busy={busy} model={model} embedMs={embedMs} result={result} />
          {result && result.hits.length === 0 && !busy && (
            <p className="mt-6 text-slate">No matches. Is the dataset loaded? Run <code>npm run ingest</code>.</p>
          )}
          <ul className={`mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 ${busy === "searching" ? "opacity-50" : ""}`}>
            {result?.hits.map((h, i) => (
              <li key={h.id} className="group overflow-hidden rounded-xl border border-line bg-surface">
                <button onClick={() => moreLikeThis(h.id, h.dish, h.url)} className="block w-full text-left" title="More like this">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={h.url} alt={h.dish} loading={i < 8 ? "eager" : "lazy"} className="aspect-square w-full object-cover" />
                  <div className="flex items-baseline justify-between gap-2 px-3 py-2.5">
                    <span className="truncate font-medium text-ink">{h.dish}</span>
                    <span className="shrink-0 font-mono text-xs text-slate" title="Cosine similarity">{(h.similarity * 100).toFixed(0)}%</span>
                  </div>
                  <div className="px-3 pb-3 text-xs text-slate group-hover:text-ink">More like this →</div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-16 border-t border-line pt-6 text-xs leading-relaxed text-slate">
        <p>
          <strong className="font-medium text-ink-2">Personal learning project.</strong> Built to learn multimodal
          vector search with turbopuffer, Vercel and in-browser models. Not affiliated with turbopuffer, Vercel, Hugging
          Face, LAION or any employer.
        </p>
        <p className="mt-2">
          Photos: Food-101 (Bossard, Guillaumin and Van Gool, ETH Zürich, 2014), via the Lance-format copy on Hugging
          Face. Embeddings: OpenCLIP ViT-B-32 (LAION-2B). Photos you search with stay in your browser; only the
          vector is sent.
        </p>
      </footer>
    </main>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3.5 py-1.5 text-sm ${active ? "border-ink bg-ink text-paper" : "border-line-2 text-ink-2 hover:border-ink"}`}
    >
      {children}
    </button>
  );
}

function ModelBadge({ model }: { model: ReturnType<typeof useClip>["state"] }) {
  if (model.status === "ready") return <span className="rounded-full bg-accent-soft px-3 py-1 text-xs text-ink-2">Model ready · runs in your browser</span>;
  if (model.status === "error") return <span className="rounded-full bg-red-50 px-3 py-1 text-xs text-red-700">Model failed to load: {model.message}</span>;
  const pct = model.total ? Math.round((model.loaded / model.total) * 100) : 0;
  return (
    <span className="rounded-full bg-accent-soft px-3 py-1 text-xs text-ink-2">
      Loading CLIP model{model.total ? ` · ${pct}% of ${(model.total / 1e6).toFixed(0)} MB` : "…"} (first visit only)
    </span>
  );
}

function QuerySummary({ query, busy, model, embedMs, result }: {
  query: Query | null; busy: "embedding" | "searching" | null; model: ReturnType<typeof useClip>["state"]; embedMs: number | null; result: SearchResult | null;
}) {
  const status =
    busy === "embedding" ? (model.status === "loading" ? "Waiting for the model to finish loading…" : "Embedding in your browser…")
    : busy === "searching" ? "Searching turbopuffer…"
    : result ? [embedMs !== null && `embedded in ${embedMs} ms in your browser`, `turbopuffer answered in ${result.ms} ms`].filter(Boolean).join(" · ")
    : "";
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-surface p-4">
      {query?.kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={query.preview} alt="Your photo" className="h-16 w-16 rounded-lg object-cover" />
      )}
      {query?.kind === "similar" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={query.url} alt={query.dish} className="h-16 w-16 rounded-lg object-cover" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm text-slate">
          {query?.kind === "text" && <>Results for <span className="text-ink">“{query.text}”</span></>}
          {query?.kind === "image" && "Results for your photo"}
          {query?.kind === "similar" && <>More like this <span className="text-ink">{query.dish}</span></>}
        </p>
        {result?.guess && !busy && (
          <p className="mt-1 font-display text-2xl text-ink">
            Looks like {result.guess.dish.toLowerCase()}
            <span className="ml-2 font-sans text-sm text-slate">{result.guess.votes} of the top {result.guess.of} matches</span>
          </p>
        )}
        <p className="mt-1 font-mono text-xs text-slate">{status}</p>
      </div>
    </div>
  );
}
