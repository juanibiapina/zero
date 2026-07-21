import { useState, useEffect, useCallback } from "react";
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
} from "@zero/ui";
import * as api from "@/lib/api";
import type { Project } from "@zero/vault-core";

export default function ProjectsPage() {
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [projects, setProjects] = useState<Project[]>([]);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);

  const tokenFn = useCallback(() => getToken(), [getToken]);

  const load = useCallback(async () => {
    const { projects } = await api.listProjects(tokenFn);
    setProjects(projects);
    setLoading(false);
  }, [tokenFn, organization?.id]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    await api.createProject(tokenFn, newName.trim());
    setNewName("");
    load();
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete project "${name}" and all its environments and secrets?`)) return;
    await api.deleteProject(tokenFn, name);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
      </div>

      <form onSubmit={handleCreate} className="flex gap-2 max-w-md">
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

      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : projects.length === 0 ? (
        <p className="text-muted-foreground">No projects yet. Create one to get started.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Card key={p.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-lg">
                  <Link
                    to={`/projects/${p.name}`}
                    className="flex items-center gap-2 hover:underline"
                  >
                    <FolderOpen className="h-4 w-4" />
                    {p.name}
                  </Link>
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(p.name)}
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
      )}
    </div>
  );
}
