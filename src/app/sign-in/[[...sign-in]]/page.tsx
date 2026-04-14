import { SignIn } from "@clerk/nextjs";

/**
 * Catch-all route (`[[...sign-in]]`) so Clerk's multi-step flow (SSO
 * callbacks, verification codes, password reset) all land inside this one
 * component. The empty-rest variant (`[[...]]`) also lets /sign-in itself
 * render without a trailing segment.
 */
export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-10">
      <SignIn />
    </div>
  );
}
