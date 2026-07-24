import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router";
import { useAuth, useOrganization } from "@clerk/clerk-react";
import { Search, Check, RotateCcw } from "lucide-react";
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
import type { IssueSummary } from "@zero/errors-core";
import * as api from "@/products/errors/lib/api";
import { LevelBadge, StatusBadge } from "@/products/errors/components/badges";

export default function IssuesPage() {
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [project, setProject] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const tokenFn = useCallback(() => getToken(), [getToken]);

  const load = useCallback(async () => {
    setLoading(true);
    const { issues } = await api.listIssues(
      tokenFn,
      project.trim() || undefined,
      showResolved ? undefined : "open",
    );
    setIssues(issues);
    setLoading(false);
  }, [tokenFn, project, showResolved, organization?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleStatus = async (issue: IssueSummary) => {
    const next = issue.status === "open" ? "resolved" : "open";
    setPendingId(issue.id);
    try {
      await api.setIssueStatus(tokenFn, issue.id, next);
      await load();
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Issues</h1>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative max-w-xs">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Filter by project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />
        </div>
        <Button
          variant={showResolved ? "default" : "outline"}
          size="sm"
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? "Hide resolved" : "Show resolved"}
        </Button>
      </div>

      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : issues.length === 0 ? (
        <p className="text-muted-foreground">No issues yet.</p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Level</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {issues.map((issue) => (
                <TableRow key={issue.id}>
                  <TableCell className="font-mono text-xs">{issue.project}</TableCell>
                  <TableCell className="max-w-md truncate">
                    <Link to={`/errors/issues/${issue.id}`} className="font-medium hover:underline">
                      {issue.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <LevelBadge level={issue.level} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{issue.count}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {new Date(issue.lastSeenAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={issue.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant={issue.status === "open" ? "default" : "outline"}
                      disabled={pendingId === issue.id}
                      onClick={() => void toggleStatus(issue)}
                    >
                      {issue.status === "open" ? (
                        <>
                          <Check className="h-4 w-4 mr-1" />
                          Resolve
                        </>
                      ) : (
                        <>
                          <RotateCcw className="h-4 w-4 mr-1" />
                          Reopen
                        </>
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
