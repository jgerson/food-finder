// Thumbs up or down on a copilot answer. Sent to Langfuse as a "user-feedback" score (BOOLEAN: 1 good, 0 bad) on the
// answer's trace, through Langfuse's public scores API. The score id is derived from the trace, so changing a vote
// replaces the earlier one instead of adding a second score.
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const pk = process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.LANGFUSE_SECRET_KEY;
  if (!pk || !sk) return Response.json({ error: "Langfuse isn't set up." }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { traceId?: unknown; value?: unknown; comment?: unknown };
  const traceId = typeof body.traceId === "string" && /^[0-9a-f]{32}$/.test(body.traceId) ? body.traceId : null;
  const value = body.value === 1 || body.value === 0 ? body.value : null;
  if (!traceId || value === null) return Response.json({ error: "Expected a trace id and a value of 1 or 0." }, { status: 400 });
  const comment = typeof body.comment === "string" ? body.comment.slice(0, 1000) : undefined;

  const base = (process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(/\/$/, "");
  const t0 = performance.now();
  const res = await fetch(`${base}/api/public/scores`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${pk}:${sk}`).toString("base64")}` },
    body: JSON.stringify({ id: `user-feedback-${traceId}`, traceId, name: "user-feedback", value, dataType: "BOOLEAN",
      comment, environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? process.env.VERCEL_ENV ?? "development" }),
  }).catch((e: Error) => e);
  const ms = Math.round(performance.now() - t0);
  const ok = !(res instanceof Error) && res.ok;
  console.log(JSON.stringify({ feedback: value === 1 ? "up" : "down", traceId, ok, ms,
    ...(res instanceof Error ? { error: res.message } : ok ? {} : { status: res.status }) }));
  return ok ? Response.json({ ok: true }) : Response.json({ error: "Couldn't save the feedback." }, { status: 502 });
}
