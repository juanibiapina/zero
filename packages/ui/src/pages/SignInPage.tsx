import { SignIn } from "@clerk/clerk-react";

export function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
    </div>
  );
}
