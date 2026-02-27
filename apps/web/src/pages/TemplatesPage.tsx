import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@clerk/clerk-react";
import { FileText, Trash2, Plus, Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { PromptTemplate } from "@zero/core";
import { jsonBody } from "@/lib/api";

interface TemplateFormData {
  name: string;
  slug: string;
  content: string;
}

const emptyForm: TemplateFormData = { name: "", slug: "", content: "" };

export default function TemplatesPage() {
  const { getToken } = useAuth();
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<TemplateFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    try {
      const token = await getToken();
      const resp = await fetch("/api/templates", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await jsonBody<{ templates?: PromptTemplate[] }>(resp);
      setTemplates(data.templates ?? []);
    } catch (err) {
      console.error("Failed to fetch templates:", err);
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    void fetchTemplates();
  }, [fetchTemplates]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
    setDialogOpen(true);
  };

  const openEdit = (t: PromptTemplate) => {
    setEditingId(t.id);
    setForm({ name: t.name, slug: t.slug, content: t.content });
    setError(null);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.slug.trim() || !form.content.trim()) {
      setError("All fields are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      const isEdit = editingId !== null;
      const url = isEdit ? `/api/templates/${editingId}` : "/api/templates";
      const method = isEdit ? "PATCH" : "POST";

      const resp = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          isEdit
            ? { name: form.name.trim(), slug: form.slug.trim(), content: form.content }
            : { name: form.name.trim(), slug: form.slug.trim(), content: form.content }
        ),
      });

      if (!resp.ok) {
        const data = await jsonBody<{ error?: string }>(resp);
        setError(data.error ?? `Failed (${resp.status})`);
        return;
      }

      setDialogOpen(false);
      await fetchTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const token = await getToken();
      await fetch(`/api/templates/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchTemplates();
    } catch (err) {
      console.error("Failed to delete template:", err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading templates...
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            <h1 className="text-2xl font-bold">Prompt Templates</h1>
          </div>
          <p className="text-muted-foreground mt-1">
            Reusable prompts invoked with <code className="text-xs bg-muted px-1 py-0.5 rounded">/slug</code> in
            the chat input. Use <code className="text-xs bg-muted px-1 py-0.5 rounded">$ARGUMENTS</code> as a
            placeholder for user-provided text.
          </p>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          New
        </Button>
      </div>

      {/* Template list */}
      {templates.length > 0 ? (
        <div className="rounded-lg border divide-y">
          {templates.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{t.name}</span>
                  <code className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                    /{t.slug}
                  </code>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {t.content.slice(0, 120)}{t.content.length > 120 ? "…" : ""}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0 ml-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEdit(t)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleDelete(t.id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No templates yet. Create one to get started.
        </p>
      )}

      {/* Create/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingId !== null ? "Edit Template" : "New Template"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-sm font-medium mb-1 block">Name</label>
                <Input
                  placeholder="Plan Mode"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="w-40">
                <label className="text-sm font-medium mb-1 block">Slug</label>
                <Input
                  placeholder="plan"
                  value={form.slug}
                  onChange={(e) =>
                    setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })
                  }
                  className="font-mono"
                />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Content</label>
              <textarea
                className="flex w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[300px] resize-y focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                placeholder={"# Plan Mode\n\nYou are in planning mode.\n\n## Task\n\n$ARGUMENTS"}
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
              />
            </div>
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              {editingId !== null ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
