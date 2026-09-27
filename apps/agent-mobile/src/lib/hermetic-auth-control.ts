export const HERMETIC_ACCOUNT_A = 'e2e-account-a';
export const HERMETIC_ACCOUNT_B = 'e2e-account-b';

const PREFIX = 'zeroagent://hermetic-sign-in/';

export function hermeticSignInRedirect(accountId: string): string {
  return `${PREFIX}${accountId}`;
}

export function accountFromHermeticSignInRedirect(
  redirectUrl: string,
): string | null {
  if (!redirectUrl.startsWith(PREFIX)) return null;
  const accountId = redirectUrl.slice(PREFIX.length);
  return accountId === HERMETIC_ACCOUNT_A || accountId === HERMETIC_ACCOUNT_B
    ? accountId
    : null;
}
