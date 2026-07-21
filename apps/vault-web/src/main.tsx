import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { AppLayout, SignInPage, SignUpPage, getProducts, type NavItem } from "@zero/ui";
import { Shield, FolderOpen, Key } from "lucide-react";

import "./index.css";
import App from "./App.tsx";
import ProjectsPage from "./pages/ProjectsPage.tsx";
import EnvironmentsPage from "./pages/EnvironmentsPage.tsx";
import SecretsPage from "./pages/SecretsPage.tsx";
import KeysPage from "./pages/KeysPage.tsx";

const navItems: NavItem[] = [
  { to: "/projects", label: "Projects", icon: FolderOpen },
  { to: "/keys", label: "API Keys", icon: Key },
];

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      {
        element: (
          <AppLayout
            brand={{ name: "Zero", icon: Shield, to: "/projects" }}
            navItems={navItems}
            afterOrgUrl="/projects"
            products={getProducts()}
            currentProductId="vault"
          />
        ),
        children: [
          { index: true, element: <ProjectsPage /> },
          { path: "projects", element: <ProjectsPage /> },
          { path: "projects/:project", element: <EnvironmentsPage /> },
          { path: "projects/:project/:env", element: <SecretsPage /> },
          { path: "keys", element: <KeysPage /> },
        ],
      },
      { path: "sign-in/*", element: <SignInPage /> },
      { path: "sign-up/*", element: <SignUpPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
