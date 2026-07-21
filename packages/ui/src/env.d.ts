interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
  readonly VITE_VAULT_URL?: string;
  readonly VITE_ERRORS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
