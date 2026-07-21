import { useState, useEffect, useCallback } from "react";
import { Link, useParams } from "react-router";
import { useAuth, useOrganization } from "@clerk/clerk-react";
import { Plus, Trash2, ArrowLeft } from "lucide-react";
import {
  Button,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@zero/ui";
import * as api from "@/lib/api";
import type { Environment } from "@zero/vault-core";

export default function EnvironmentsPage() {
  const { project } = useParams<{ project: string }>();
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);

  const tokenFn = useCallback(() => getToken(), [getToken]);

  const load = useCallback(async () => {
    if (!project) return;
    const { environments } = await api.listEnvironments(tokenFn, project);
    setEnvironments(environments);
    setLoading(false);
  }, [tokenFn, project, organization?.id]);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !project) return;
    await api.createEnvironment(tokenFn, project, newName.trim());
    setNewName("");
    void load();
  };

  const handleDelete = async (envName: string) => {
    if (!project) return;
    if (!confirm(`Delete environment "${envName}" and all its secrets?`)) return;
    await api.deleteEnvironment(tokenFn, project, envName);
    void load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/projects">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-2xl font-bold">{project}</h1>
      </div>

      <form onSubmit={(e) => void handleCreate(e)} className="flex gap-2 max-w-md">
        <Input
          placeholder="New environment name"
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
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Environment</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-24">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {environments.map((env) => (
              <TableRow key={env.id}>
                <TableCell>
                  <Link
                    to={`/projects/${project}/${env.name}`}
                    className="font-medium hover:underline"
                  >
                    {env.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(env.createdAt).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleDelete(env.name)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
