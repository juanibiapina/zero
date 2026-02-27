import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "@clerk/clerk-react";
import { Loader2, FolderGit2 } from "lucide-react";
import PickerDialog from "@/components/PickerDialog";
import { jsonBody } from "@/lib/api";
import type { ProjectSummary } from "@zero/core";

interface ProjectPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const filterProject = (p: ProjectSummary, query: string) =>
  p.fullName.toLowerCase().includes(query.toLowerCase());

const projectKey = (p: ProjectSummary) => p.fullName;

const ProjectItem = ({ project }: { project: ProjectSummary }) => (
  <>
    <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
    <span className="truncate font-medium">{project.fullName}</span>
    {project.description && (
      <span className="ml-auto truncate text-xs text-muted-foreground max-w-[40%]">
        {project.description}
      </span>
    )}
  </>
);

export default function ProjectPickerDialog({
  open,
  onOpenChange,
}: ProjectPickerDialogProps) {
  const { getToken } = useAuth();
  const navigate = useNavigate();

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Non-archived projects
  const activeProjects = projects.filter((p) => !p.archived);

  // Fetch projects when dialog opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setCreating(false);
    setLoading(true);

    void (async () => {
      try {
        const token = await getToken();
        const resp = await fetch("/api/projects", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await jsonBody<{ projects?: ProjectSummary[] }>(resp);
        setProjects(data.projects ?? []);
      } catch {
        setProjects([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [open, getToken]);

  const handleSelect = useCallback(
    async (project: ProjectSummary) => {
      setCreating(true);
      setError(null);
      try {
        const token = await getToken();
        const resp = await fetch("/api/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            owner: project.owner,
            repo: project.repo,
          }),
        });
        if (!resp.ok) {
          let message = `Failed to create session (${resp.status})`;
          try {
            const parsed = (await resp.json()) as { error?: string };
            if (parsed.error) message = parsed.error;
          } catch {
            // Response wasn't JSON
          }
          throw new Error(message);
        }
        const data = (await resp.json()) as { sessionId: string };
        onOpenChange(false);
        void navigate(
          `/p/${project.owner}/${project.repo}/sessions/${data.sessionId}`,
        );
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to create session",
        );
        setCreating(false);
      }
    },
    [getToken, navigate, onOpenChange],
  );

  const renderItem = useCallback(
    (project: ProjectSummary) => <ProjectItem project={project} />,
    [],
  );

  const extraFooter = (
    <>
      {loading && (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          <span className="text-sm">Loading projects...</span>
        </div>
      )}
      {error && (
        <div className="border-t px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {creating && (
        <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Creating session...
        </div>
      )}
    </>
  );

  return (
    <PickerDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New Session"
      description="Select a project to create a new session"
      placeholder="Search projects..."
      items={loading ? [] : activeProjects}
      filterFn={filterProject}
      renderItem={renderItem}
      onSelect={(p) => void handleSelect(p)}
      keyFn={projectKey}
      disabled={creating}
      enterVerb="create session"
      emptyMessage="No matching projects"
      noItemsMessage={loading ? "" : "No projects found"}
      extraFooter={extraFooter}
    />
  );
}
