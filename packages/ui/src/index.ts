/**
 * ============================================================================
 * @zero/ui — Shared web shell for the Zero suite
 * ============================================================================
 *
 * Clerk auth provider, shadcn `ui/*` primitives, the parameterized AppLayout,
 * sign-in/up pages, and the fetchApi client. Consumers also import the theme:
 *   import "@zero/ui/styles.css";
 */

export { cn } from "./lib/utils";
export { fetchApi, type GetToken } from "./lib/api";
export { useAsyncData, type AsyncData } from "./hooks/useAsyncData";
export { AsyncState, type AsyncStateProps } from "./components/AsyncState";

export { AuthProvider } from "./auth/AuthProvider";
export { AppLayout, type AppLayoutProps, type NavItem } from "./components/AppLayout";
export { getProducts, type ProductLink, type ProductId } from "./products";
export { SignInPage, type SignInPageProps } from "./pages/SignInPage";
export { SignUpPage, type SignUpPageProps } from "./pages/SignUpPage";

export { Button, buttonVariants } from "./components/ui/button";
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
} from "./components/ui/card";
export { Input } from "./components/ui/input";
export { Label } from "./components/ui/label";
export { Toaster } from "./components/ui/sonner";
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from "./components/ui/table";
