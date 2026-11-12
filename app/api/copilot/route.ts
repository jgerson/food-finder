// POST /api/copilot  { messages, screen?, conversationId? }  ->  NDJSON stream of CopilotEvent
import type Anthropic from "@anthropic-ai/sdk";
import { after } from "next/server";
import { copilotEnabled, runCopilot, type CopilotEvent, type ScreenContext } from "@/lib/copilot";
import { isCourse } from "@/lib/search";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  if (!copilotEnabled) {
    return Response.json({ error: "The copilot is off. Deploy on Vercel with AI Gateway, or set AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY." }, { status: 503 });
  }
  const body = (await req.json().catch(() => ({}))) as { messages?: unknown; screen?: unknown; conversationId?: unknown };
  const messages = cleanMessages(body.messages);
  if (!messages.length || messages.at(-1)!.role !== "user") return Response.json({ error: "Expected a question." }, { status: 400 });
  const screen = cleanScreen(body.screen);
  // Langfuse groups a conversation's questions into one session; the browser makes a new id per conversation.
  const sessionId = typeof body.conversationId === "string" && /^[\w-]{8,64}$/.test(body.conversationId) ? body.conversationId : undefined;

  after(flushLangfuse);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: CopilotEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        await newTrace({ userId: user, sessionId, tags: ["copilot"], traceName: "copilot",
          metadata: { screenQuery: screen?.query ?? "none" } }, () => runCopilot(messages, screen, emit));
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}

// The conversation as plain text turns only (the last 12), so the browser can't inject tool calls or results.
function cleanMessages(raw: unknown): Anthropic.MessageParam[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-12).flatMap((m) => {
    const role = (m as { role?: unknown }).role, content = (m as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) return [];
    return [{ role, content: content.slice(0, 4000) }];
  });
}

function cleanScreen(raw: unknown): ScreenContext | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const hits = Array.isArray(s.hits) ? s.hits.slice(0, 12).flatMap((h) => {
    const x = h as Record<string, unknown>;
    return typeof x.id === "string" && /^[a-z]+-\d+$/.test(x.id) && typeof x.dish === "string" && typeof x.url === "string"
      && x.url.startsWith("https://") && typeof x.similarity === "number"
      ? [{ id: x.id, dish: x.dish.slice(0, 60), url: x.url, similarity: x.similarity }] : [];
  }) : [];
  return {
    query: typeof s.query === "string" ? s.query.slice(0, 200) : "a search",
    course: isCourse(s.course) ? s.course : null,
    guess: typeof s.guess === "string" ? s.guess.slice(0, 60) : null,
    hits,
  };
}
