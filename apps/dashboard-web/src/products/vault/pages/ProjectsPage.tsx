import { useState, useCallback } from "react";
import { Link } from "react-router";
import { useAuth, useOrganization } from "@clerk/clerk-react";
import { Plus, Trash2, FolderOpen } from "lucide-react";
import {
  Button,
  Input,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  useAsyncData,
  AsyncState,
} from "@zero/ui";
import * as api from "@/products/vault/lib/api";

export default function ProjectsPage() {
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [newName, setNewName] = useState("");

  const tokenFn = useCallback(() => getToken(), [getToken]);

  const state = useAsyncData(
    () => api.listProjects(tokenFn),
    [tokenFn, organization?.id],
  );
  const { reload } = state;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    await api.createProject(tokenFn, newName.trim());
    setNewName("");
    reload();
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete project "${name}" and all its environments and secrets?`)) return;
    await api.deleteProject(tokenFn, name);
    reload();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
      </div>

      <form onSubmit={(e) => void handleCreate(e)} className="flex gap-2 max-w-md">
        <Input
          placeholder="New project name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <Button type="submit" size="sm">
          <Plus className="h-4 w-4 mr-1" />
          Create
        </Button>
      </form>

      <AsyncState state={state} onRetry={reload}>
        {({ projects }) =>
          projects.length === 0 ? (
            <p className="text-muted-foreground">
              No projects yet. Create one to get started. New to ZeroVault?{" "}
              <a
                href="https://docs.zeroapps.dev/vault/getting-started/"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
              >
                Read the getting-started guide
              </a>
              .
            </p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => (
                <Card key={p.id}>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-lg">
                      <Link
                        to={`/vault/projects/${p.name}`}
                        className="flex items-center gap-2 hover:underline"
                      >
                        <FolderOpen className="h-4 w-4" />
                        {p.name}
                      </Link>
                    </CardTitle>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleDelete(p.name)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      Created {new Date(p.createdAt).toLocaleDateString()}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )
        }
      </AsyncState>
    </div>
  );
}
