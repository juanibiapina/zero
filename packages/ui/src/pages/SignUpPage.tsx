import { SignUp } from "@clerk/clerk-react";

export interface SignUpPageProps {
  /** Where to land after sign-up when the URL carries no explicit redirect_url. */
  fallbackRedirectUrl?: string;
}

export function SignUpPage({ fallbackRedirectUrl }: SignUpPageProps = {}) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        fallbackRedirectUrl={fallbackRedirectUrl}
      />
    </div>
  );
}
