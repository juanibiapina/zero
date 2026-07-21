import { SignUp } from "@clerk/clerk-react";

export function SignUpPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
    </div>
  );
}
