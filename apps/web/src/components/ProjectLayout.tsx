import { Outlet } from "react-router";

/**
 * Layout wrapper for project-scoped routes (/p/:owner/:repo/*).
 *
 * Currently a thin pass-through — gives us a place to add project-level
 * context (provider defaults, project settings, etc.) later without
 * changing the route tree.
 */
export default function ProjectLayout() {
  return <Outlet />;
}
