import { Navigate, type RouteObject } from "react-router";
import {
  AppLayout,
  SignInPage,
  SignUpPage,
  getProducts,
  type AccountNav,
  type NavItem,
} from "@zero/ui";
import { Bug, FolderOpen, Key, Shield, ListChecks } from "lucide-react";
import App from "./App";
import ProjectsPage from "./products/vault/pages/ProjectsPage";
import EnvironmentsPage from "./products/vault/pages/EnvironmentsPage";
import SecretsPage from "./products/vault/pages/SecretsPage";
import KeysPage from "./account/pages/KeysPage";
import IssuesPage from "./products/errors/pages/IssuesPage";
import IssueDetailPage from "./products/errors/pages/IssueDetailPage";

const vaultNav: NavItem[] = [
  { to: "/vault/projects", label: "Projects", icon: FolderOpen },
];
const errorsNav: NavItem[] = [{ to: "/errors/issues", label: "Issues", icon: ListChecks }];

/** Shown on every shell: keys are organization-scoped, not owned by a product. */
const accountNav: AccountNav = {
  items: [{ to: "/keys", label: "API keys", icon: Key }],
};

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Navigate to="/vault/projects" replace /> },
      {
        path: "vault",
        element: <AppLayout brand={{ name: "Zero", icon: Shield, to: "/vault/projects" }} navItems={vaultNav} accountNav={accountNav} afterOrgUrl="/vault/projects" products={getProducts()} currentProductId="vault" />,
        children: [
          { index: true, element: <Navigate to="projects" replace /> },
          { path: "projects", element: <ProjectsPage /> },
          { path: "projects/:project", element: <EnvironmentsPage /> },
          { path: "projects/:project/:env", element: <SecretsPage /> },
        ],
      },
      {
        path: "errors",
        element: <AppLayout brand={{ name: "Zero", icon: Bug, to: "/errors/issues" }} navItems={errorsNav} accountNav={accountNav} afterOrgUrl="/errors/issues" products={getProducts()} currentProductId="errors" />,
        children: [
          { index: true, element: <Navigate to="issues" replace /> },
          { path: "issues", element: <IssuesPage /> },
          { path: "issues/:id", element: <IssueDetailPage /> },
        ],
      },
      {
        // No current product, and an iconless brand: a Key mark under the word
        // Zero would read as a third product.
        path: "keys",
        element: <AppLayout brand={{ name: "Zero", to: "/keys" }} navItems={[]} accountNav={accountNav} afterOrgUrl="/keys" products={getProducts()} />,
        children: [{ index: true, element: <KeysPage /> }],
      },
      // Keys used to live in Vault. This sits at the root rather than inside
      // the Vault shell, which only renders its outlet once Clerk has loaded
      // an active organization: nested, the redirect would never mount for a
      // user without one.
      { path: "vault/keys", element: <Navigate to="/keys" replace /> },
      { path: "sign-in/*", element: <SignInPage fallbackRedirectUrl="/vault/projects" forceRedirectUrl={`${window.location.origin}/vault/projects`} /> },
      { path: "sign-up/*", element: <SignUpPage fallbackRedirectUrl="/vault/projects" forceRedirectUrl={`${window.location.origin}/vault/projects`} /> },
    ],
  },
];
