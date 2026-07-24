import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Navigate, createBrowserRouter, RouterProvider } from "react-router";
import { AppLayout, SignInPage, SignUpPage, getProducts, type NavItem } from "@zero/ui";
import { Bug, FolderOpen, Key, Shield, ListChecks } from "lucide-react";
import "./index.css";
import App from "./App";
import ProjectsPage from "./products/vault/pages/ProjectsPage";
import EnvironmentsPage from "./products/vault/pages/EnvironmentsPage";
import SecretsPage from "./products/vault/pages/SecretsPage";
import KeysPage from "./products/vault/pages/KeysPage";
import IssuesPage from "./products/errors/pages/IssuesPage";
import IssueDetailPage from "./products/errors/pages/IssueDetailPage";

const vaultNav: NavItem[] = [
  { to: "/vault/projects", label: "Projects", icon: FolderOpen },
  { to: "/vault/keys", label: "API Keys", icon: Key },
];
const errorsNav: NavItem[] = [{ to: "/errors/issues", label: "Issues", icon: ListChecks }];

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Navigate to="/vault/projects" replace /> },
      {
        path: "vault",
        element: <AppLayout brand={{ name: "Zero", icon: Shield, to: "/vault/projects" }} navItems={vaultNav} afterOrgUrl="/vault/projects" products={getProducts()} currentProductId="vault" />,
        children: [
          { index: true, element: <Navigate to="projects" replace /> },
          { path: "projects", element: <ProjectsPage /> },
          { path: "projects/:project", element: <EnvironmentsPage /> },
          { path: "projects/:project/:env", element: <SecretsPage /> },
          { path: "keys", element: <KeysPage /> },
        ],
      },
      {
        path: "errors",
        element: <AppLayout brand={{ name: "Zero", icon: Bug, to: "/errors/issues" }} navItems={errorsNav} afterOrgUrl="/errors/issues" products={getProducts()} currentProductId="errors" />,
        children: [
          { index: true, element: <Navigate to="issues" replace /> },
          { path: "issues", element: <IssuesPage /> },
          { path: "issues/:id", element: <IssueDetailPage /> },
        ],
      },
      { path: "sign-in/*", element: <SignInPage fallbackRedirectUrl="/vault/projects" forceRedirectUrl={`${window.location.origin}/vault/projects`} /> },
      { path: "sign-up/*", element: <SignUpPage fallbackRedirectUrl="/vault/projects" forceRedirectUrl={`${window.location.origin}/vault/projects`} /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode><RouterProvider router={router} /></StrictMode>,
);
