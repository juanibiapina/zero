import { Redirect } from 'expo-router';

// After native OAuth, Clerk's Custom Tab redirects to `zeroagent://sso-callback`.
// expo-web-browser captures that URL to complete the sign-in, but Android ALSO
// delivers it to the app as a deep link, so expo-router navigates here. Without
// this route the app lands on a dead (not-found) screen and never shows the
// signed-in state. Bouncing back to `/` returns to the todo home with the
// updated session.
export default function SSOCallback() {
  return <Redirect href="/" />;
}
