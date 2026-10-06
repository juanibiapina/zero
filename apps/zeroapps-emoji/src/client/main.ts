import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/fraunces/full-italic.css";
import "./styles.css";

type Suggestion = { emoji: string; name: string };

const form = document.querySelector<HTMLFormElement>("#ask")!;
const input = document.querySelector<HTMLInputElement>("#q")!;
const examples = document.querySelector<HTMLElement>("#examples")!;
const status = document.querySelector<HTMLElement>("#status")!;
const announce = document.querySelector<HTMLElement>("#announce")!;
const grid = document.querySelector<HTMLUListElement>("#grid")!;
const share = document.querySelector<HTMLElement>("#share")!;
const shareButton = document.querySelector<HTMLButtonElement>("#share-button")!;

const TYPING_PAUSE_MS = 600;
const MIN_AUTO_LENGTH = 3;

let latest = 0;
let lastQuery = "";
let typingTimer: ReturnType<typeof setTimeout> | undefined;

const setStatus = (text: string, tone: "plain" | "problem" = "plain") => {
  status.textContent = text;
  if (tone === "problem") status.dataset.tone = "problem";
  else delete status.dataset.tone;
};

const clearResults = () => {
  grid.replaceChildren();
  grid.removeAttribute("aria-busy");
  share.hidden = true;
};

const copy = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

const tile = (suggestion: Suggestion, index: number): HTMLLIElement => {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tile";
  button.style.setProperty("--i", String(index));
  button.setAttribute("aria-label", `Copy ${suggestion.name}`);
  const glyph = document.createElement("span");
  glyph.className = "tile-emoji";
  glyph.textContent = suggestion.emoji;
  glyph.setAttribute("aria-hidden", "true");
  button.title = suggestion.name;
  const copied = document.createElement("span");
  copied.className = "tile-copied";
  copied.textContent = "Copied";
  copied.setAttribute("aria-hidden", "true");
  button.append(glyph, copied);
  let reset: ReturnType<typeof setTimeout> | undefined;
  const onClick = async () => {
    const ok = await copy(suggestion.emoji);
    if (!ok) return setStatus("Couldn't copy. Select the emoji and copy it by hand.", "problem");
    setStatus("");
    for (const other of grid.querySelectorAll(".tile[data-copied]")) other.removeAttribute("data-copied");
    button.setAttribute("data-copied", "");
    announce.textContent = `Copied ${suggestion.name}`;
    clearTimeout(reset);
    reset = setTimeout(() => button.removeAttribute("data-copied"), 1400);
  };
  button.addEventListener("click", () => void onClick());
  item.append(button);
  return item;
};

const render = (suggestions: Suggestion[]) => {
  grid.removeAttribute("aria-busy");
  grid.removeAttribute("data-fresh");
  grid.replaceChildren(...suggestions.map(tile));
  void grid.offsetWidth;
  grid.setAttribute("data-fresh", "");
  share.hidden = false;
};

const search = async (query: string) => {
  lastQuery = query;
  const id = ++latest;
  examples.hidden = true;
  setStatus("");
  grid.setAttribute("aria-busy", "true");
  try {
    const response = await fetch(`/api/suggest?q=${encodeURIComponent(query)}`);
    if (id !== latest) return;
    if (!response.ok) clearResults();
    if (response.status === 429) return setStatus("Lots of people are asking right now. Try again in a minute.", "problem");
    const body = (await response.json().catch(() => ({}))) as { emoji?: Suggestion[]; error?: string };
    if (!response.ok) return setStatus(body.error ?? "Couldn't suggest right now. Try again.", "problem");
    const suggestions = body.emoji ?? [];
    if (suggestions.length === 0) {
      clearResults();
      return setStatus("No suggestions. Try describing it differently.");
    }
    render(suggestions);
  } catch {
    if (id !== latest) return;
    clearResults();
    setStatus("Couldn't reach the server. Check your connection and try again.", "problem");
  }
};

const queryFromUrl = () => new URLSearchParams(location.search).get("q")?.trim() ?? "";

const run = (query: string, push: boolean) => {
  clearTimeout(typingTimer);
  const url = new URL(location.href);
  url.searchParams.set("q", query);
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
  document.title = `Emoji for ${query}`;
  void search(query);
};

input.addEventListener("input", () => {
  clearTimeout(typingTimer);
  const query = input.value.trim();
  if (query.length < MIN_AUTO_LENGTH || query === lastQuery) return;
  typingTimer = setTimeout(() => run(query, false), TYPING_PAUSE_MS);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) return input.focus();
  if (query === lastQuery) return;
  run(query, queryFromUrl() !== query);
});

examples.addEventListener("click", (event) => {
  const example = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-example]")?.dataset.example;
  if (!example) return;
  input.value = example;
  run(example, true);
});

const onShare = async () => {
  const url = location.href;
  if (navigator.share) {
    try {
      await navigator.share({ title: document.title, url });
      return;
    } catch (error) {
      if ((error as DOMException).name === "AbortError") return;
    }
  }
  setStatus((await copy(url)) ? "Link copied. Send it to a friend." : url);
};

shareButton.addEventListener("click", () => void onShare());

window.addEventListener("popstate", () => {
  const query = queryFromUrl();
  input.value = query;
  if (query) void search(query);
  else {
    latest++;
    clearResults();
    setStatus("");
    examples.hidden = false;
  }
});

const initial = queryFromUrl();
if (initial) {
  input.value = initial;
  run(initial, false);
} else {
  input.focus();
}
