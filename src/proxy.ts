import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Paths the signed-out public may hit without a redirect. Clerk's own
// sign-in/sign-up UIs must be listed here, and anything truly world-readable
// (favicons, Next.js static chunks). Everything else — API routes, pages —
// requires a valid session.
//
// NOTE: Book covers live at /api/books/[id]/cover and already enforce
// visibility server-side via loadBookForRead. We *don't* add them here
// because the cover route itself calls getCurrentUser, and without a
// session that would bounce to sign-in. Fine — covers only load in the
// authenticated library UI anyway.
const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  // Clerk's own callback/OAuth routes
  "/api/clerk(.*)",
]);

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts` (same signature, same
 * semantics — see node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md).
 * Clerk's `clerkMiddleware` still slots in here unchanged because it returns
 * a function with the same `(req, event) => NextResponse` shape either file
 * expects.
 *
 * We gate non-public routes with `auth.protect()`, which redirects
 * unauthenticated users to /sign-in. Downstream API handlers then call
 * `getCurrentUser()` (src/lib/auth.ts) to get the session-bound user row.
 */
export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  // Match everything except Next.js internals and static assets. Keeping
  // this tight so we don't incur auth overhead on every CSS/image request.
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
