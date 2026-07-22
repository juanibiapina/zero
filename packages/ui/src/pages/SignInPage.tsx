import { SignIn } from "@clerk/clerk-react";

export interface SignInPageProps {
  /** Where to land after sign-in when the URL carries no explicit redirect_url. */
  fallbackRedirectUrl?: string;
}

export function SignInPage({ fallbackRedirectUrl }: SignInPageProps = {}) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        fallbackRedirectUrl={fallbackRedirectUrl}
      />
    </div>
  );
}
