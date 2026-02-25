import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@clerk/clerk-react";
import { Link } from "react-router";
import {
  FolderGit2,
  Lock,
  Globe,
  ExternalLink,
  Loader2,
  ChevronRight,
  AlertCircle,
  Link2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProjectSummary } from "@zero/core";

function ManualLinkInput({ onLinked }: { onLinked: () => void }) {
  const { getToken } = useAuth();
  const [installationId, setInstallationId] = useState("");
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLink() {
    const id = Number(installationId.trim());
    if (!id || !Number.isInteger(id) || id <= 0) {
      setError("Enter a valid installation ID");
      return;
    }

    setLinking(true);
    setError(null);
    try {
      const token = await getToken();
      const resp = await fetch("/api/auth/github/callback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ installationId: id }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `HTTP ${resp.status}`);
      }
      setInstallationId("");
      onLinked();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to link");
    } finally {
      setLinking(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Installation ID"
          value={installationId}
          onChange={(e) => {
            setInstallationId(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && handleLink()}
          className="w-40"
          disabled={linking}
        />
        <Button variant="outline" onClick={handleLink} disabled={linking}>
          {linking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
          Link
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export default function ProjectsPage() {
  const { getToken } = useAuth();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchProjects = useCallback(async () => {
    try {
      const token = await getToken();
      const resp = await fetch("/api/projects", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json();
      setProjects(data.projects ?? []);
      setInstallUrl(data.installUrl ?? null);
      setErrors(data.errors ?? []);
    } catch (err) {
      console.error("Failed to fetch projects:", err);
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading projects...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <FolderGit2 className="h-5 w-5" />
          <h1 className="text-2xl font-bold">Projects</h1>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <ManualLinkInput onLinked={fetchProjects} />
          {installUrl && (
            <Button variant="outline" asChild>
              <a href={installUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
                Install GitHub App
              </a>
            </Button>
          )}
        </div>
      </div>

      {errors.length > 0 && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive space-y-1">
          <div className="flex items-center gap-2 font-medium">
            <AlertCircle className="h-4 w-4" />
            Failed to load some installations
          </div>
          {errors.map((e, i) => (
            <div key={i} className="pl-6 text-muted-foreground">{e}</div>
          ))}
        </div>
      )}

      {projects.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <FolderGit2 className="mx-auto h-10 w-10 text-muted-foreground" />
          <h3 className="mt-2 font-semibold">No projects yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Install the GitHub App on your account to see your repos here.
          </p>
          <div className="mt-4 flex flex-col items-center gap-3">
            {installUrl && (
              <Button asChild>
                <a href={installUrl} target="_blank" rel="noopener noreferrer">
                  Install GitHub App
                </a>
              </Button>
            )}
            <div className="text-xs text-muted-foreground">or paste an existing installation ID</div>
            <ManualLinkInput onLinked={fetchProjects} />
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          {projects.map((project) => (
            <Link
              key={project.fullName}
              to={`/projects/${project.owner}/${project.repo}`}
              className="flex items-center justify-between rounded-lg border p-4 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                {project.private ? (
                  <Lock className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Globe className="h-4 w-4 text-muted-foreground" />
                )}
                <div>
                  <div className="font-medium">{project.fullName}</div>
                  {project.description && (
                    <div className="text-sm text-muted-foreground">
                      {project.description}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="text-xs">{project.defaultBranch}</span>
                <ChevronRight className="h-4 w-4" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
