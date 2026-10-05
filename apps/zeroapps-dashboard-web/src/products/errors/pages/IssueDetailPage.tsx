import { useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useAuth, useOrganization } from "@clerk/react";
import { ArrowLeft, Check, RotateCcw, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  useAsyncData,
  AsyncState,
  toast,
} from "@zero/ui";
import * as api from "@/products/errors/lib/api";
import { LevelBadge, StatusBadge } from "@/products/errors/components/badges";

export default function IssueDetailPage() {
  const { id = "" } = useParams();
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const navigate = useNavigate();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const tokenFn = useCallback(() => getToken(), [getToken]);

  const state = useAsyncData(
    () => api.getIssue(tokenFn, id),
    [tokenFn, id, organization?.id],
  );
  const { reload } = state;

  const toggleStatus = async (status: "open" | "resolved") => {
    const next = status === "open" ? "resolved" : "open";
    await api.setIssueStatus(tokenFn, id, next);
    reload();
  };

  const confirmDelete = async () => {
    await api.deleteIssue(tokenFn, id);
    toast.success("Issue deleted");
    void navigate("/errors/issues");
  };

  return (
    <AsyncState state={state} onRetry={reload}>
      {({ issue, events }) => (
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
            <div className="flex items-center gap-2">
              <Button variant={issue.status === "open" ? "default" : "outline"} size="sm" onClick={() => void toggleStatus(issue.status)}>
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
              <Button variant="outline" size="sm" onClick={() => setConfirmingDelete(true)}>
                <Trash2 className="h-4 w-4 mr-1 text-destructive" />
                Delete
              </Button>
            </div>
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

          {confirmingDelete && (
            <ConfirmDialog
              open
              onOpenChange={setConfirmingDelete}
              title="Delete this issue?"
              description={`"${issue.title}" and its stored events will be removed from ZeroErrors. This cannot be undone here. If the same error is reported again it comes back as a new issue.`}
              confirmLabel="Delete issue"
              onConfirm={confirmDelete}
              onError={(error) =>
                toast.error(
                  error instanceof Error ? error.message : "Could not delete the issue",
                )
              }
            />
          )}
        </div>
      )}
    </AsyncState>
  );
}
