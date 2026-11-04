import type { MergeableStore, Row } from "tinybase";

const TABLE = "prompts";
const MAX_SUGGESTIONS = 6;

export type PromptAnswer = { text: string; answeredAt: string };

// An agent's mark that it handled the Prompt, with the answer it handled
// (null when it handled the Prompt before any answer).
export type PromptHandled = { at: string; answer: PromptAnswer | null };

export type PromptComment = { id: string; quote: string; text: string; createdAt: string };

export type PromptCommentInput = { quote: string; text: string };

export type Prompt = {
  id: string;
  title: string;
  text: string;
  suggestions: string[];
  createdAt: string;
  seenAt: string | null;
  answer: PromptAnswer | null;
  handled: PromptHandled | null;
  comments: PromptComment[];
};

export type PromptInput = { title: string; text: string; suggestions: string[] };

export type PromptStatus = "unread" | "read" | "answered";

export type PromptConflict =
  | "id-conflict"
  | "invalid-prompt"
  | "missing-prompt"
  | "empty-answer"
  | "already-answered"
  | "empty-comment"
  | "missing-comment";

const COMMENT = "comment:";

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

function toAnswer(value: unknown): PromptAnswer | null {
  if (typeof value !== "object" || value === null) return null;
  const { text, answeredAt } = value as Record<string, unknown>;
  return isText(text) && isTime(answeredAt) ? { text, answeredAt } : null;
}

const readAnswer = (cell: unknown) => toAnswer(parse(cell));

function readHandled(cell: unknown): PromptHandled | null {
  const value = parse(cell);
  if (typeof value !== "object" || value === null) return null;
  const { at, answer } = value as Record<string, unknown>;
  if (!isTime(at)) return null;
  if (answer === null) return { at, answer: null };
  const handledAnswer = toAnswer(answer);
  return handledAnswer ? { at, answer: handledAnswer } : null;
}

const sameAnswer = (a: PromptAnswer | null, b: PromptAnswer | null) =>
  a === null || b === null ? a === b : a.text === b.text && a.answeredAt === b.answeredAt;

function readComments(row: Row): PromptComment[] {
  return Object.keys(row)
    .filter((cell) => cell.startsWith(COMMENT))
    .flatMap((cell) => {
      const value = parse(row[cell]);
      if (typeof value !== "object" || value === null) return [];
      const { quote, text, createdAt } = value as Record<string, unknown>;
      return typeof quote === "string" && isText(text) && isTime(createdAt)
        ? [{ id: cell.slice(COMMENT.length), quote, text, createdAt }]
        : [];
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
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
    handled: readHandled(row.handled),
    comments: readComments(row),
  };
}

export const promptStatus = (prompt: Prompt): PromptStatus =>
  prompt.answer ? "answered" : prompt.seenAt ? "read" : "unread";

// A Prompt is handled while its answer is the one the agent handled. An answer
// that differs, also one that syncs in from another phone, makes it unhandled.
export const isPromptHandled = (prompt: Prompt): boolean =>
  prompt.handled !== null && sameAnswer(prompt.handled.answer, prompt.answer);

// The mark an answer change undid, or null.
export const promptChangedAfterHandling = (prompt: Prompt): PromptHandled | null =>
  prompt.handled !== null && !isPromptHandled(prompt) ? prompt.handled : null;

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

  // Marking a handled Prompt again keeps its first time. Marking one whose
  // answer changed after handling pins the mark to the current answer.
  setHandled(id: string, handled: boolean): PromptResult<Prompt> {
    const prompt = this.get(id);
    if (!prompt) return { ok: false, conflict: "missing-prompt" };
    if (handled ? isPromptHandled(prompt) : prompt.handled === null) return { ok: true, changed: false, value: prompt };
    if (handled) {
      this.store.setCell(TABLE, id, "handled", JSON.stringify({ at: this.now().toISOString(), answer: prompt.answer }));
    } else {
      this.store.delCell(TABLE, id, "handled");
    }
    return { ok: true, changed: true, value: this.get(id)! };
  }

  // A comment is one cell on the Prompt's row, so comments from several devices
  // merge, and deleting the Prompt removes them with it.
  comment(id: string, commentId: string, input: PromptCommentInput): PromptResult<PromptComment> {
    const text = input.text.trim();
    if (!text) return { ok: false, conflict: "empty-comment" };
    const prompt = this.get(id);
    if (!prompt) return { ok: false, conflict: "missing-prompt" };
    if (prompt.answer) return { ok: false, conflict: "already-answered" };
    const existing = prompt.comments.find((comment) => comment.id === commentId);
    if (existing) return { ok: true, changed: false, value: existing };
    const comment = { quote: input.quote.trim(), text, createdAt: this.now().toISOString() };
    this.store.setCell(TABLE, id, COMMENT + commentId, JSON.stringify(comment));
    return { ok: true, changed: true, value: { id: commentId, ...comment } };
  }

  removeComment(id: string, commentId: string): PromptResult<null> {
    const prompt = this.get(id);
    if (!prompt) return { ok: false, conflict: "missing-prompt" };
    if (prompt.answer) return { ok: false, conflict: "already-answered" };
    if (!this.store.hasCell(TABLE, id, COMMENT + commentId)) return { ok: false, conflict: "missing-comment" };
    this.store.delCell(TABLE, id, COMMENT + commentId);
    return { ok: true, changed: true, value: null };
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
