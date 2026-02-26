import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";

import "./index.css";
import App from "./App";
import Layout from "./components/Layout";
import DashboardPage from "./pages/DashboardPage";
import ProjectsPage from "./pages/ProjectsPage";
import ProjectDetailPage from "./pages/ProjectDetailPage";
import SessionPage from "./pages/SessionPage";
import SettingsPage from "./pages/SettingsPage";
import ProvidersPage from "./pages/ProvidersPage";
import SecretsPage from "./pages/SecretsPage";
import GitHubSetupPage from "./pages/GitHubSetupPage";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: "projects", element: <ProjectsPage /> },
          {
            path: "projects/:owner/:repo",
            element: <ProjectDetailPage />,
          },
          {
            path: "sessions/:id",
            element: <SessionPage />,
          },
          { path: "settings", element: <SettingsPage /> },
          { path: "settings/providers", element: <ProvidersPage /> },
          { path: "secrets", element: <SecretsPage /> },
          { path: "github/setup", element: <GitHubSetupPage /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
