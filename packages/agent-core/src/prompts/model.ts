import type { MergeableStore, Row } from "tinybase";

const TABLE = "prompts";
const MAX_SUGGESTIONS = 6;

export type PromptAnswer = { text: string; answeredAt: string };

export type Prompt = {
  id: string;
  title: string;
  text: string;
  suggestions: string[];
  createdAt: string;
  seenAt: string | null;
  answer: PromptAnswer | null;
};

export type PromptInput = { title: string; text: string; suggestions: string[] };

export type PromptStatus = "unread" | "read" | "answered";

export type PromptConflict = "id-conflict" | "invalid-prompt" | "missing-prompt" | "empty-answer" | "already-answered";

export type PromptResult<T> =
  | { ok: true; changed: boolean; value: T }
  | { ok: false; conflict: PromptConflict };

const isTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function parse(cell: unknown): unknown {
  if (typeof cell !== "string") return undefined;
  try {
    return JSON.parse(cell);
  } catch {
    return undefined;
  }
}

function validSuggestions(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_SUGGESTIONS
    && value.every(isText)
    && new Set(value).size === value.length;
}

function readAnswer(cell: unknown): PromptAnswer | null {
  const value = parse(cell);
  if (typeof value !== "object" || value === null) return null;
  const { text, answeredAt } = value as Record<string, unknown>;
  return isText(text) && isTime(answeredAt) ? { text, answeredAt } : null;
}

function readPrompt(id: string, row: Row): Prompt | null {
  const { title, text, createdAt, seenAt } = row;
  const suggestions = parse(row.suggestions);
  if (!isText(title) || !isText(text) || !isTime(createdAt) || !validSuggestions(suggestions)) return null;
  return {
    id,
    title,
    text,
    suggestions,
    createdAt,
    seenAt: isTime(seenAt) ? seenAt : null,
    answer: readAnswer(row.answer),
  };
}

export const promptStatus = (prompt: Prompt): PromptStatus =>
  prompt.answer ? "answered" : prompt.seenAt ? "read" : "unread";

const sameContent = (prompt: Prompt, input: PromptInput) =>
  prompt.title === input.title
  && prompt.text === input.text
  && JSON.stringify(prompt.suggestions) === JSON.stringify(input.suggestions);

export class PromptModel {
  constructor(
    private readonly store: MergeableStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(id: string, input: PromptInput): PromptResult<Prompt> {
    const content = { title: input.title.trim(), text: input.text.trim(), suggestions: input.suggestions.map((s) => s.trim()) };
    if (!isText(content.title) || !isText(content.text) || !validSuggestions(content.suggestions)) {
      return { ok: false, conflict: "invalid-prompt" };
    }
    if (this.store.hasRow(TABLE, id)) {
      const existing = this.get(id);
      return existing && sameContent(existing, content)
        ? { ok: true, changed: false, value: existing }
        : { ok: false, conflict: "id-conflict" };
    }
    this.store.setRow(TABLE, id, {
      title: content.title,
      text: content.text,
      suggestions: JSON.stringify(content.suggestions),
      createdAt: this.now().toISOString(),
    });
    return { ok: true, changed: true, value: this.get(id)! };
  }

  markSeen(id: string): PromptResult<Prompt> {
    const prompt = this.get(id);
    if (!prompt) return { ok: false, conflict: "missing-prompt" };
    if (prompt.seenAt) return { ok: true, changed: false, value: prompt };
    this.store.setCell(TABLE, id, "seenAt", this.now().toISOString());
    return { ok: true, changed: true, value: this.get(id)! };
  }

  answer(id: string, text: string): PromptResult<Prompt> {
    const answer = text.trim();
    if (!answer) return { ok: false, conflict: "empty-answer" };
    const prompt = this.get(id);
    if (!prompt) return { ok: false, conflict: "missing-prompt" };
    if (prompt.answer) {
      return prompt.answer.text === answer
        ? { ok: true, changed: false, value: prompt }
        : { ok: false, conflict: "already-answered" };
    }
    const at = this.now().toISOString();
    this.store.transaction(() => {
      if (!prompt.seenAt) this.store.setCell(TABLE, id, "seenAt", at);
      this.store.setCell(TABLE, id, "answer", JSON.stringify({ text: answer, answeredAt: at }));
    });
    return { ok: true, changed: true, value: this.get(id)! };
  }

  delete(id: string): PromptResult<null> {
    if (!this.store.hasRow(TABLE, id)) return { ok: true, changed: false, value: null };
    this.store.delRow(TABLE, id);
    return { ok: true, changed: true, value: null };
  }

  get(id: string): Prompt | null {
    return this.store.hasRow(TABLE, id) ? readPrompt(id, this.store.getRow(TABLE, id)) : null;
  }

  list(): Prompt[] {
    return this.store.getRowIds(TABLE)
      .flatMap((id) => readPrompt(id, this.store.getRow(TABLE, id)) ?? [])
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  }

  unanswered(): Prompt[] {
    return this.list().filter((prompt) => !prompt.answer).reverse();
  }

  onChange(id: string, listener: () => void): () => void {
    const listenerId = this.store.addRowListener(TABLE, id, () => listener());
    return () => { this.store.delListener(listenerId); };
  }
}
