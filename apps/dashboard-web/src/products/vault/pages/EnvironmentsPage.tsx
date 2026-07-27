import { useState, useCallback } from "react";
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
  useAsyncData,
  AsyncState,
} from "@zero/ui";
import * as api from "@/products/vault/lib/api";

export default function EnvironmentsPage() {
  const { project } = useParams<{ project: string }>();
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [newName, setNewName] = useState("");

  const tokenFn = useCallback(() => getToken(), [getToken]);

  const state = useAsyncData(
    () =>
      project
        ? api.listEnvironments(tokenFn, project)
        : Promise.resolve({ environments: [] }),
    [tokenFn, project, organization?.id],
  );
  const { reload } = state;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !project) return;
    await api.createEnvironment(tokenFn, project, newName.trim());
    setNewName("");
    reload();
  };

  const handleDelete = async (envName: string) => {
    if (!project) return;
    if (!confirm(`Delete environment "${envName}" and all its secrets?`)) return;
    await api.deleteEnvironment(tokenFn, project, envName);
    reload();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/vault/projects">
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

      <AsyncState state={state} onRetry={reload}>
        {({ environments }) => (
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
                      to={`/vault/projects/${project}/${env.name}`}
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
      </AsyncState>
    </div>
  );
}
