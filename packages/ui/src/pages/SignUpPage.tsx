import { SignUp } from "@clerk/clerk-react";

export interface SignUpPageProps {
  /** Where to land after sign-up when the URL carries no explicit redirect_url. */
  fallbackRedirectUrl?: string;
  /** Always land here after sign-up, overriding Clerk's instance default. */
  forceRedirectUrl?: string;
}

export function SignUpPage({ fallbackRedirectUrl, forceRedirectUrl }: SignUpPageProps = {}) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        fallbackRedirectUrl={fallbackRedirectUrl}
        forceRedirectUrl={forceRedirectUrl}
      />
    </div>
  );
}
