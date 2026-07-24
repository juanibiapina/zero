import { LayoutDashboard, Shield, Bug, type LucideIcon } from "lucide-react";

export type ProductId = "dashboard" | "vault" | "errors";

export interface ProductLink {
  id: ProductId;
  label: string;
  icon: LucideIcon;
  /** Same-origin dashboard path. */
  href: string;
}

/** The canonical product list for the unified Zero dashboard. */
export function getProducts(): ProductLink[] {
  return [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, href: "/" },
    { id: "vault", label: "Vault", icon: Shield, href: "/vault" },
    { id: "errors", label: "Errors", icon: Bug, href: "/errors" },
  ];
}
