import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { AppLayout, SignInPage, SignUpPage, getProducts, type NavItem } from "@zero/ui";
import { Bug, ListChecks } from "lucide-react";

import "./index.css";
import App from "./App.tsx";
import IssuesPage from "./pages/IssuesPage.tsx";
import IssueDetailPage from "./pages/IssueDetailPage.tsx";

const navItems: NavItem[] = [{ to: "/issues", label: "Issues", icon: ListChecks }];

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      {
        element: (
          <AppLayout
            brand={{ name: "Zero", icon: Bug, to: "/issues" }}
            navItems={navItems}
            afterOrgUrl="/issues"
            products={getProducts()}
            currentProductId="errors"
          />
        ),
        children: [
          { index: true, element: <IssuesPage /> },
          { path: "issues", element: <IssuesPage /> },
          { path: "issues/:id", element: <IssueDetailPage /> },
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
