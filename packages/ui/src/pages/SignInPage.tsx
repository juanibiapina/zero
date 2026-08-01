import { SignIn } from "@clerk/react";

export interface SignInPageProps {
  /** Where to land after sign-in when the URL carries no explicit redirect_url. */
  fallbackRedirectUrl?: string;
  /** Always land here after sign-in, overriding Clerk's instance default. */
  forceRedirectUrl?: string;
}

export function SignInPage({ fallbackRedirectUrl, forceRedirectUrl }: SignInPageProps = {}) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        fallbackRedirectUrl={fallbackRedirectUrl}
        forceRedirectUrl={forceRedirectUrl}
      />
    </div>
  );
}
