import { Shield, Bug, type LucideIcon } from "lucide-react";

export type ProductId = "vault" | "errors";

export interface ProductLink {
  id: ProductId;
  label: string;
  icon: LucideIcon;
  /** Absolute, cross-subdomain URL. */
  href: string;
}

// Zero-branded production hosts.
const PROD_VAULT_URL = "https://vault.juanibiapina.dev";
const PROD_ERRORS_URL = "https://errors.juanibiapina.dev";

/**
 * The canonical Zero product list, shared by every app so the two consoles
 * cannot drift. Hosts default to the current production subdomains and can be
 * overridden per app via `VITE_VAULT_URL` / `VITE_ERRORS_URL` for localhost dev.
 */
export function getProducts(): ProductLink[] {
  const vaultUrl = import.meta.env.VITE_VAULT_URL ?? PROD_VAULT_URL;
  const errorsUrl = import.meta.env.VITE_ERRORS_URL ?? PROD_ERRORS_URL;
  return [
    { id: "vault", label: "Vault", icon: Shield, href: vaultUrl },
    { id: "errors", label: "Errors", icon: Bug, href: errorsUrl },
  ];
}
