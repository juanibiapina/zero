// Picks the Project a Task being typed most likely belongs to, or none. One
// SystemOne Choice over the candidate Projects plus a `none` option; the answer
// counts only when its probability reaches SUGGEST_THRESHOLD. The cutoff and
// wording were measured with Jev on real Projects (see packages/typesafe/README.md).
//
// It never throws: a decision failure or an unexpected answer is a soft miss,
// because a missing suggestion leaves quick add exactly as it was.

import type { Decide, SystemOneRequest } from "@zeroapps/typesafe";

export type ProjectCandidate = {
  id: string;
  title: string;
  icon: string;
  description: string | null;
  tasks: string[];
};

export type ProjectSuggestion = {
  projectId: string | null;
  confidence: number | null;
  inputTokens: number | null;
};

export const SUGGEST_THRESHOLD = 0.5;

const NONE = "none";
const QUESTION = "project";
const MISS: ProjectSuggestion = { projectId: null, confidence: null, inputTokens: null };

const describe = (project: ProjectCandidate): string => {
  const parts = [`${project.icon} ${project.title}.`];
  if (project.description) parts.push(project.description);
  if (project.tasks.length > 0) parts.push(`Open tasks: ${project.tasks.join("; ")}`);
  return parts.join(" ");
};

const buildRequest = (
  title: string,
  projects: ProjectCandidate[],
): { request: SystemOneRequest; keys: Map<string, string> } => {
  const keys = new Map<string, string>();
  const criteria: Record<string, string> = {};
  projects.forEach((project, index) => {
    const key = `p${index + 1}`;
    keys.set(key, project.id);
    criteria[key] = describe(project);
  });
  criteria[NONE] =
    "None of these projects: the task is a standalone chore or errand unrelated to every listed project.";
  return {
    keys,
    request: {
      state: { draft_task: title },
      questions: {
        [QUESTION]: {
          type: "choice",
          instructions: {
            context:
              "The user is typing a new task into their personal todo app. Each option is one of their projects, with the open tasks already filed under it.",
            question: "Under which project would the user file the task in `draft_task`?",
          },
          criteria,
        },
      },
    },
  };
};

export const suggestProject = async (
  decide: Decide,
  input: { title: string; projects: ProjectCandidate[] },
): Promise<ProjectSuggestion> => {
  if (input.projects.length === 0) return MISS;
  const { request, keys } = buildRequest(input.title, input.projects);
  try {
    const response = await decide(request);
    const answer = response?.answers?.[QUESTION];
    if (answer?.type !== "choice" || typeof answer.choice !== "string") return MISS;
    const probability = answer.probabilities?.[answer.choice];
    if (typeof probability !== "number") return MISS;
    const inputTokens = response.usage?.input_tokens ?? null;
    const projectId = keys.get(answer.choice) ?? null;
    if (projectId === null || probability < SUGGEST_THRESHOLD) {
      return { projectId: null, confidence: probability, inputTokens };
    }
    return { projectId, confidence: probability, inputTokens };
  } catch {
    return MISS;
  }
};
