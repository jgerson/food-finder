// Runs before every request: everything except the sign-in page needs a signed-in user, so the app isn't open to
// the internet. There is no sign-up page; accounts are created in Clerk's dashboard (shared with TrialScope).
// Pages redirect to /sign-in; API routes get a 404 from auth.protect().
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Branch caption-bakeoff only: the temporary caption endpoint has its own token check.
const isPublic = createRouteMatcher(["/sign-in(.*)", "/api/admin/caption", "/api/admin/caption-write"]);

// Clerk's production keys belong to the trialscope.space instance, so production runs on a subdomain of it.
const AUTHORIZED_ORIGINS = ["https://food.trialscope.space"];

export default clerkMiddleware(
  async (auth, req) => {
    if (!isPublic(req)) await auth.protect();
  },
  {
    signInUrl: "/sign-in",
    // In production, accept session tokens only when issued for this app's origin (Clerk's recommendation).
    // Previews and local dev use other origins and Clerk's development keys, so they keep the default.
    authorizedParties: process.env.VERCEL_ENV === "production" ? AUTHORIZED_ORIGINS : undefined,
  },
);

export const config = {
  matcher: [
    // Skip Next.js internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
