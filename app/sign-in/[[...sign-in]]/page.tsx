import { SignIn } from "@clerk/nextjs";

export const metadata = { title: "Sign in · Food Finder" };

export default function SignInPage() {
  // withSignUp={false}: there is no sign-up page, so an unknown email can't create an account here.
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-5">
      <h1 className="mb-6 font-display text-4xl text-ink">Food Finder</h1>
      <SignIn withSignUp={false} />
    </main>
  );
}
