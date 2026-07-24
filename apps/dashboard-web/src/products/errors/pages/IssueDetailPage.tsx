import { useState, useEffect, useCallback } from "react";
import { Link, useParams } from "react-router";
import { useAuth, useOrganization } from "@clerk/clerk-react";
import { ArrowLeft, Check, RotateCcw } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@zero/ui";
import type { IssueDetailResponse } from "@zero/errors-core";
import * as api from "@/products/errors/lib/api";
import { LevelBadge, StatusBadge } from "@/products/errors/components/badges";

export default function IssueDetailPage() {
  const { id = "" } = useParams();
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [data, setData] = useState<IssueDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const tokenFn = useCallback(() => getToken(), [getToken]);

  const load = useCallback(async () => {
    setLoading(true);
    const detail = await api.getIssue(tokenFn, id);
    setData(detail);
    setLoading(false);
  }, [tokenFn, id, organization?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleStatus = async () => {
    if (!data) return;
    const next = data.issue.status === "open" ? "resolved" : "open";
    await api.setIssueStatus(tokenFn, id, next);
    void load();
  };

  if (loading) return <p className="text-muted-foreground">Loading...</p>;
  if (!data) return <p className="text-muted-foreground">Issue not found.</p>;

  const { issue, events } = data;

  return (
    <div className="space-y-6">
      <Link to="/errors/issues" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" />
        Back to issues
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">{issue.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono text-xs">{issue.project}</span>
            <LevelBadge level={issue.level} />
            <StatusBadge status={issue.status} />
            <span>·</span>
            <span>{issue.count} occurrences</span>
            <span>·</span>
            <span>first {new Date(issue.firstSeenAt).toLocaleString()}</span>
            <span>·</span>
            <span>last {new Date(issue.lastSeenAt).toLocaleString()}</span>
          </div>
        </div>
        <Button variant={issue.status === "open" ? "default" : "outline"} size="sm" onClick={() => void toggleStatus()}>
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
      </div>

      <h2 className="text-lg font-semibold">Recent events</h2>
      {events.length === 0 ? (
        <p className="text-muted-foreground">No events recorded.</p>
      ) : (
        <div className="space-y-4">
          {events.map((event) => (
            <Card key={event.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium break-all">
                  {event.message}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  {new Date(event.createdAt).toLocaleString()}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {event.stack && (
                  <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                    {event.stack}
                  </pre>
                )}
                {event.context && (
                  <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                    {JSON.stringify(event.context, null, 2)}
                  </pre>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
