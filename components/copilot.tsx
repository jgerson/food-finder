"use client";
// Copilot panel: streams Claude's answer, lists each tool call it makes, and turns [R1]/[P2] tags into photo chips.
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, ChevronRight, Loader2, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import type { Cited, ScreenContext, Usage } from "@/lib/copilot";

interface Step { tool: string; input: Record<string, unknown>; results: number; ms: number; reasoning?: string; summary: string }
interface Turn {
  q: string; answer: string; steps: Step[]; cites: Record<string, Cited>; pending: boolean;
  seconds?: number; error?: string; notice?: string; usage?: Usage; traceId?: string; finished?: boolean;
}

const TOOL_NAMES: Record<string, string> = {
  show_dish_photos: "Dish photos", similar_dishes: "Similar dishes", more_like_photo: "More like a photo",
};

export function Copilot({ screen, onPhoto }: { screen: ScreenContext | null; onPhoto: (c: Cited) => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const busy = turns.some((t) => t.pending);
  const end = useRef<HTMLDivElement>(null);
  const conversation = useRef<string>("");
  useEffect(() => { conversation.current = crypto.randomUUID(); }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [turns]);

  const suggestions = screen?.hits.length
    ? ["Why did these results come up?", `What else looks like ${(screen.guess ?? screen.hits[0].dish).toLowerCase()}?`, "Which of these is the odd one out, and why?"]
    : ["What does bibimbap look like?", "Which dishes does the model confuse with pho?", "Show me three desserts side by side"];

  async function ask(q: string) {
    if (!q.trim()) { setInputError("Type a question first."); return; }
    if (busy) return;
    setInput("");
    setInputError(null);
    const history = turns.filter((t) => !t.error && t.answer).flatMap((t) => [
      { role: "user", content: t.q }, { role: "assistant", content: t.answer },
    ]);
    const idx = turns.length;
    setTurns((ts) => [...ts, { q, answer: "", steps: [], cites: {}, pending: true }]);
    const update = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t, i) => (i === idx ? fn(t) : t)));
    try {
      const res = await fetch("/api/copilot", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [...history, { role: "user", content: q }], screen, conversationId: conversation.current }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? "The copilot didn't respond.");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "text") update((t) => ({ ...t, answer: t.answer + ev.delta }));
          // Text written before a tool call is a preamble; the next step replaces it.
          else if (ev.type === "step") update((t) => ({ ...t, answer: "", steps: [...t.steps, ev] }));
          else if (ev.type === "citations") update((t) => ({ ...t, cites: ev.items }));
          else if (ev.type === "error") update((t) => ({ ...t, error: ev.message }));
          else if (ev.type === "usage") update((t) => ({ ...t, usage: ev.usage }));
          else if (ev.type === "notice") update((t) => ({ ...t, notice: ev.message }));
          else if (ev.type === "trace") update((t) => ({ ...t, traceId: ev.id }));
          else if (ev.type === "done") update((t) => ({ ...t, seconds: ev.seconds, finished: true }));
        }
      }
    } catch (e) {
      update((t) => ({ ...t, error: (e as Error).message }));
    } finally {
      update((t) => ({ ...t, pending: false,
        ...(!t.finished && !t.error ? { notice: "The answer stopped before it finished. Try asking again." } : {}) }));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-6 overflow-y-auto pb-4">
        {!turns.length && (
          <div>
            <p className="text-[14px] leading-relaxed text-ink-2">
              Ask about the results on screen, what a dish looks like, or which dishes the model finds alike.
              Answers cite the photos they use; click one to search with it.
            </p>
            <div className="mt-4 space-y-2">
              {suggestions.map((s) => (
                <button key={s} onClick={() => ask(s)}
                  className="block w-full rounded-xl border border-line px-3.5 py-2.5 text-left text-[13.5px] text-ink-2 hover:border-ink hover:text-ink">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i}>
            <div className="ml-auto w-fit max-w-[88%] rounded-2xl rounded-br-md bg-ink px-3.5 py-2.5 text-[14px] text-paper">{t.q}</div>
            {t.steps.length > 0 && <ol className="mt-3 space-y-1.5">{t.steps.map((s, j) => <StepRow key={j} step={s} />)}</ol>}
            {t.pending && !t.answer && (
              <p className="mt-3 inline-flex items-center gap-2 text-[13px] text-slate">
                <Loader2 size={14} className="animate-spin" />{t.steps.length ? "Reading results" : "Thinking"}
              </p>
            )}
            {t.answer && <Answer text={t.answer} cites={t.cites} onPhoto={onPhoto} />}
            {t.error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-800">{t.error}</p>}
            {t.notice && <p className="mt-3 rounded-xl border border-line px-3 py-2 text-[12.5px] text-slate">{t.notice}</p>}
            {t.seconds != null && <Footer turn={t} />}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void ask(input); }} className="border-t border-line pt-3">
        <div className="flex items-end gap-2">
          <textarea value={input} rows={2} placeholder="Ask the copilot…" aria-label="Ask the copilot"
            onChange={(e) => { setInput(e.target.value); if (inputError) setInputError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
            className="min-w-0 flex-1 resize-none rounded-xl border border-line-2 bg-surface px-3 py-2 text-[14px] outline-none focus:border-ink" />
          <button type="submit" disabled={busy} aria-label="Send"
            className="rounded-xl bg-ink p-2.5 text-paper disabled:opacity-50"><ArrowUp size={16} /></button>
        </div>
        {inputError && <p className="mt-1.5 text-[12.5px] text-red-700">{inputError}</p>}
        <p className="mt-1.5 text-[11.5px] text-slate">Answers can be wrong. Photos show how dishes look, not what&apos;s in them.</p>
      </form>
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-line text-[12.5px]">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <ChevronRight size={13} className={`shrink-0 text-slate transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="font-medium text-ink">{TOOL_NAMES[step.tool] ?? step.tool}</span>
        <span className="truncate text-slate">{step.summary}</span>
        <span className="ml-auto shrink-0 font-mono text-slate">{Math.round(step.ms)} ms</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-2.5 py-2">
          {step.reasoning && <p className="whitespace-pre-wrap leading-relaxed text-ink-2">{step.reasoning}</p>}
          <pre className="overflow-auto rounded bg-accent-soft p-2 font-mono text-[11px] text-ink-2">{JSON.stringify(step.input, null, 2)}</pre>
        </div>
      )}
    </li>
  );
}

const TAG_RE = /\[([RP]\d+)\]/g;

function Answer({ text, cites, onPhoto }: { text: string; cites: Record<string, Cited>; onPhoto: (c: Cited) => void }) {
  // [R2] becomes a link the renderer below turns into a photo chip; tags with no photo stay as text.
  const linked = text.replace(TAG_RE, (m, tag: string) => (cites[tag] ? `[${tag}](#cite-${tag})` : m));
  const shown = [...new Set([...text.matchAll(TAG_RE)].map((m) => m[1]))].filter((t) => cites[t]);
  return (
    <div className="mt-3">
      <div className="prose-sm text-[14px] leading-relaxed text-ink [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
          a: ({ href, children }) => {
            const tag = href?.startsWith("#cite-") ? href.slice(6) : null;
            const c = tag ? cites[tag] : null;
            if (!c) return <a href={href} target="_blank" rel="noreferrer" className="underline">{children}</a>;
            return (
              <button onClick={() => onPhoto(c)} title={`${c.dish}: search with this photo`}
                className="mx-0.5 inline-flex translate-y-0.5 items-center gap-1 rounded-full border border-line-2 bg-surface py-0.5 pl-0.5 pr-1.5 align-baseline text-[11.5px] text-ink-2 hover:border-ink">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.url} alt="" className="h-4 w-4 rounded-full object-cover" />{tag}
              </button>
            );
          },
        }}>{linked}</ReactMarkdown>
      </div>
      {shown.length > 0 && (
        <div className="mt-3 grid grid-cols-4 gap-1.5">
          {shown.slice(0, 12).map((t) => (
            <button key={t} onClick={() => onPhoto(cites[t])} title={`${cites[t].dish}: search with this photo`} className="group relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={cites[t].url} alt={cites[t].dish} className="aspect-square w-full rounded-lg object-cover group-hover:opacity-80" />
              <span className="absolute left-1 top-1 rounded bg-ink/80 px-1 font-mono text-[10px] text-paper">{t}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Footer({ turn }: { turn: Turn }) {
  const [vote, setVote] = useState<0 | 1 | null>(null);
  const [failed, setFailed] = useState(false);
  const send = async (value: 0 | 1) => {
    if (!turn.traceId) return;
    setVote(value);
    setFailed(false);
    const r = await fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceId: turn.traceId, value }) }).catch(() => null);
    if (!r?.ok) { setFailed(true); setVote(null); }
  };
  const u = turn.usage;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-slate">
      <span>{turn.seconds!.toFixed(1)} s</span>
      {u && <span>{u.calls} model call{u.calls > 1 ? "s" : ""} · {(u.inTokens + u.outTokens).toLocaleString()} tokens{u.cost != null ? ` · $${u.cost.toFixed(4)}` : ""}</span>}
      {turn.traceId && (
        <span className="ml-auto inline-flex gap-1">
          <button onClick={() => send(1)} aria-label="Good answer" className={`rounded p-1 hover:text-ink ${vote === 1 ? "text-ink" : ""}`}><ThumbsUp size={13} /></button>
          <button onClick={() => send(0)} aria-label="Bad answer" className={`rounded p-1 hover:text-ink ${vote === 0 ? "text-ink" : ""}`}><ThumbsDown size={13} /></button>
        </span>
      )}
      {failed && <span className="text-red-700">Couldn&apos;t save feedback.</span>}
    </div>
  );
}

export { Sparkles };
