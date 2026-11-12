// POST /api/search
//   { vector: number[512], course?: Course, limit?: number }   search by a query embedding
//   { id: string, course?: Course, limit?: number }            "more like this" for a stored image
import { auth } from "@clerk/nextjs/server";
import { DIM, isCourse, searchById, searchByVector } from "@/lib/search";

const MAX_LIMIT = 48;

export async function POST(req: Request) {
  // proxy.ts already blocks signed-out requests; this is the second check.
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Sign in required" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const course = isCourse(body.course) ? body.course : undefined;
  const limit = Math.min(Math.max(Number(body.limit) || 24, 1), MAX_LIMIT);

  try {
    if (typeof body.id === "string" && /^[a-z]+-\d+$/.test(body.id)) {
      const result = await searchById(body.id, { course, limit });
      return result ? Response.json(result) : Response.json({ error: "Unknown id" }, { status: 404 });
    }
    const v = body.vector;
    if (!Array.isArray(v) || v.length !== DIM || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
      return Response.json({ error: `vector must be ${DIM} finite numbers` }, { status: 400 });
    }
    return Response.json(await searchByVector(v as number[], { course, limit }));
  } catch (err) {
    console.error("search failed", err);
    return Response.json({ error: "Search failed" }, { status: 500 });
  }
}
