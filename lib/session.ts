// The signed-in Clerk user, for API routes. proxy.ts already blocks signed-out requests; this is the second check.
import "server-only";
import { auth } from "@clerk/nextjs/server";

/** The user id, or a 401 response to return as-is. */
export async function requireUserId(): Promise<string | Response> {
  const { userId } = await auth();
  return userId ?? Response.json({ error: "Sign in required" }, { status: 401 });
}
