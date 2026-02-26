/**
 * GitHub App Setup Callback Page
 *
 * GitHub redirects here after the user installs the GitHub App.
 * URL: /github/setup?installation_id=123&setup_action=install
 *
 * This page calls the API to link the installation to the user's
 * UserDO, then redirects to /projects.
 */

import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { Loader2, CheckCircle, XCircle } from "lucide-react";

export default function GitHubSetupPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { getToken } = useAuth();
  const [status, setStatus] = useState<"linking" | "success" | "error">("linking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function linkInstallation() {
      // If the state param indicates a local dev origin, redirect there
      // so the local frontend handles the callback against the local API.
      const state = searchParams.get("state");
      if (state && /^localhost:\d+$/.test(state)) {
        const params = new URLSearchParams(searchParams);
        params.delete("state");
        window.location.href = `http://${state}/github/setup?${params.toString()}`;
        return;
      }

      const installationId = searchParams.get("installation_id");
      const setupAction = searchParams.get("setup_action");

      if (!installationId) {
        setStatus("error");
        setError("Missing installation_id parameter");
        return;
      }

      // If setup_action is "request", the user requested access but
      // an org admin hasn't approved yet — nothing to link.
      if (setupAction === "request") {
        setStatus("error");
        setError("Installation request pending org admin approval.");
        return;
      }

      try {
        const token = await getToken();
        const resp = await fetch("/api/auth/github/callback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ installationId: Number(installationId) }),
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          let errorMsg = `HTTP ${resp.status}`;
          try {
            const parsed = JSON.parse(text) as { error?: string };
            if (parsed.error) errorMsg = parsed.error;
          } catch { /* use default errorMsg */ }
          throw new Error(errorMsg);
        }

        setStatus("success");
        // Redirect to projects after a brief moment
        setTimeout(() => navigate("/projects", { replace: true }), 1500);
      } catch (err) {
        console.error("Failed to link GitHub installation:", err);
        setStatus("error");
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    }

    void linkInstallation();
  }, [searchParams, getToken, navigate]);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center space-y-3">
        {status === "linking" && (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground">Linking GitHub installation...</p>
          </>
        )}
        {status === "success" && (
          <>
            <CheckCircle className="mx-auto h-8 w-8 text-green-500" />
            <p className="font-medium">GitHub App connected!</p>
            <p className="text-sm text-muted-foreground">Redirecting to projects...</p>
          </>
        )}
        {status === "error" && (
          <>
            <XCircle className="mx-auto h-8 w-8 text-destructive" />
            <p className="font-medium">Failed to link GitHub App</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <button
              onClick={() => void navigate("/projects", { replace: true })}
              className="mt-2 text-sm text-primary underline"
            >
              Go to Projects
            </button>
          </>
        )}
      </div>
    </div>
  );
}
