import { Command, CommanderError, Option } from "commander";

import { Api, DEFAULT_API_URL, type Project, type ProjectState, type Task } from "./api";
import { CliError, deleteLogin, LOGIN_HINT, login, readLogin, type Env } from "./auth";
import packageJson from "../package.json" with { type: "json" };

export type Io = {
  env: Env;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  openBrowser: (url: string) => Promise<void>;
  confirm: ((question: string) => Promise<boolean>) | null;
};

type JsonFlag = { json?: boolean };

function table(rows: string[][]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows
    .map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join("  "))
    .join("\n") + "\n";
}

const taskTable = (tasks: Task[]) => table([
  ["ID", "DATE", "TEXT"],
  ...tasks.map((task) => [task.id, task.showUpDate ?? "-", task.recurrence ? `${task.text} ↻` : task.text]),
]);

const projectTable = (projects: Project[]) => table([
  ["ID", "STATE", "ATTENTION", "TITLE"],
  ...projects.map((project) => [project.id, project.state, project.attention ?? "-", `${project.icon} ${project.title}`]),
]);

function buildProgram(io: Io): Command {
  const program = new Command()
    .name("zero-todo")
    .description("Tasks and Projects in Zero's todo app")
    .version(packageJson.version)
    .option("--api-url <url>", "Zero API origin (default: $ZERO_TODO_API_URL or https://zero.juanibiapina.dev)")
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .showHelpAfterError();

  program.addHelpText("after", [
    "",
    "Sign in once with `zero-todo auth login`. ZERO_TODO_TOKEN overrides the stored sign-in with a raw bearer token.",
    "Exit codes: 0 success, 1 the API refused or input was wrong, 75 the API was unreachable or failed.",
  ].join("\n"));

  const api = () => new Api(program.opts<{ apiUrl?: string }>().apiUrl ?? io.env.ZERO_TODO_API_URL ?? DEFAULT_API_URL, io.env);

  const print = <T>(options: JsonFlag, body: T, human: (body: T) => string) => {
    io.stdout(options.json ? `${JSON.stringify(body, null, 2)}\n` : human(body));
  };

  const json = (command: Command) => command.option("--json", "Print the response body as JSON");

  const auth = program.command("auth").description("Sign in to Zero");

  auth.command("login")
    .description("Sign in through the browser")
    .option("--port <port>", "Port for the sign-in callback on 127.0.0.1 (default: any free port)", (value) => Number(value))
    .action(async (options: { port?: number }) => {
      const result = await login(io.env, { port: options.port, openBrowser: io.openBrowser, stderr: io.stderr });
      io.stdout(`Signed in as ${result.email ?? result.userId}\n`);
    });

  auth.command("logout")
    .description("Forget the stored sign-in")
    .action(async () => {
      await deleteLogin(io.env);
      io.stdout("Signed out\n");
    });

  auth.command("status")
    .description("Show who is signed in")
    .action(async () => {
      if (io.env.ZERO_TODO_TOKEN) {
        io.stdout("Using the token in ZERO_TODO_TOKEN\n");
        return;
      }
      const stored = await readLogin(io.env);
      if (!stored) throw new CliError("not signed in", 1, LOGIN_HINT);
      io.stdout(`Signed in to ${stored.issuer} as ${stored.email ?? stored.userId}\n`);
    });

  const tasks = program.command("tasks").description("List and change Tasks");

  json(tasks.command("list"))
    .description("List Tasks not completed")
    .option("--home", "Only the Tasks on Home today")
    .option("--project <id>", "Only the Tasks of this Project")
    .action(async (options: JsonFlag & { home?: boolean; project?: string }) => {
      const query = new URLSearchParams();
      if (options.home) query.set("view", "home");
      if (options.project) query.set("projectId", options.project);
      const search = query.size ? `?${query.toString()}` : "";
      const body = await api().request<{ today: string; tasks: Task[] }>("GET", `/api/v1/tasks${search}`);
      print(options, body, ({ tasks }) => taskTable(tasks));
    });

  json(tasks.command("add"))
    .description("Add a Task")
    .argument("<text>", "What to do")
    .option("--project <id>", "Add it to this Project")
    .option("--on <date>", "Day it shows up, YYYY-MM-DD")
    .action(async (text: string, options: JsonFlag & { project?: string; on?: string }) => {
      const body = await api().request<{ task: Task }>("POST", "/api/v1/tasks", {
        text,
        ...(options.on ? { showUpDate: options.on } : {}),
        ...(options.project ? { parent: { kind: "project", projectId: options.project } } : {}),
      });
      print(options, body, ({ task }) => taskTable([task]));
    });

  json(tasks.command("edit"))
    .description("Change a Task's text, day, or Project")
    .argument("<id>", "Task id")
    .option("--text <text>", "New text")
    .addOption(new Option("--on <date>", "Day it shows up, YYYY-MM-DD").conflicts("date"))
    .option("--no-date", "Make it current every day")
    .addOption(new Option("--project <id>", "Move it to this Project").conflicts("loose"))
    .option("--loose", "Take it out of its Project")
    .action(async (id: string, options: JsonFlag & { text?: string; on?: string; date: boolean; project?: string; loose?: boolean }) => {
      const patch = {
        ...(options.text !== undefined ? { text: options.text } : {}),
        ...(options.on ? { showUpDate: options.on } : {}),
        ...(options.date === false ? { showUpDate: null } : {}),
        ...(options.project ? { parent: { kind: "project", projectId: options.project } } : {}),
        ...(options.loose ? { parent: null } : {}),
      };
      if (Object.keys(patch).length === 0) throw new CliError("nothing to update; pass --text, --on, --no-date, --project, or --loose");
      const body = await api().request<{ task: Task }>("PATCH", `/api/v1/tasks/${encodeURIComponent(id)}`, patch);
      print(options, body, ({ task }) => taskTable([task]));
    });

  for (const [name, action, description] of [
    ["done", "complete", "Complete a Task; a recurring Task moves to its next occurrence"],
    ["reopen", "reopen", "Reopen a completed Task"],
  ] as const) {
    json(tasks.command(name))
      .description(description)
      .argument("<id>", "Task id")
      .action(async (id: string, options: JsonFlag) => {
        const body = await api().request<{ task: Task }>("POST", `/api/v1/tasks/${encodeURIComponent(id)}/${action}`);
        print(options, body, ({ task }) => taskTable([task]));
      });
  }

  const projects = program.command("projects").description("List and change Projects");

  json(projects.command("list"))
    .description("List Projects that are not done")
    .option("--all", "Include done Projects")
    .action(async (options: JsonFlag & { all?: boolean }) => {
      const body = await api().request<{ today: string; projects: Project[] }>(
        "GET", `/api/v1/projects${options.all ? "?includeDone=true" : ""}`);
      print(options, body, ({ projects }) => projectTable(projects));
    });

  json(projects.command("add"))
    .description("Add a Project")
    .argument("<title>", "Project title")
    .option("--icon <emoji>", "One emoji (default 📁)")
    .option("--backlog", "Start it in the backlog")
    .action(async (title: string, options: JsonFlag & { icon?: string; backlog?: boolean }) => {
      const body = await api().request<{ project: Project }>("POST", "/api/v1/projects", {
        title,
        ...(options.icon ? { icon: options.icon } : {}),
        ...(options.backlog ? { state: "backlog" } : {}),
      });
      print(options, body, ({ project }) => projectTable([project]));
    });

  json(projects.command("edit"))
    .description("Change a Project's title, icon, or description")
    .argument("<id>", "Project id")
    .option("--title <title>", "New title")
    .option("--icon <emoji>", "New icon")
    .option("--description <text>", "New description")
    .option("--no-description", "Clear the description")
    .action(async (id: string, options: JsonFlag & { title?: string; icon?: string; description?: string | false }) => {
      const patch = {
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.icon !== undefined ? { icon: options.icon } : {}),
        ...(options.description !== undefined ? { description: options.description || null } : {}),
      };
      if (Object.keys(patch).length === 0) throw new CliError("nothing to update; pass --title, --icon, --description, or --no-description");
      const body = await api().request<{ project: Project }>("PATCH", `/api/v1/projects/${encodeURIComponent(id)}`, patch);
      print(options, body, ({ project }) => projectTable([project]));
    });

  json(projects.command("state"))
    .description("Move a Project to in-play, backlog, or done")
    .argument("<id>", "Project id")
    .addArgument(new Command().createArgument("<state>", "New state").choices(["in-play", "backlog", "done"]))
    .action(async (id: string, state: ProjectState, options: JsonFlag) => {
      const body = await api().request<{ project: Project }>("PATCH", `/api/v1/projects/${encodeURIComponent(id)}`, { state });
      print(options, body, ({ project }) => projectTable([project]));
    });

  json(projects.command("delete"))
    .description("Delete a Project with its Tasks, Waiting conditions, and Afters")
    .argument("<id>", "Project id")
    .option("--yes", "Do not ask for confirmation")
    .action(async (id: string, options: JsonFlag & { yes?: boolean }) => {
      if (!options.yes) {
        if (!io.confirm) throw new CliError("pass --yes to delete without a prompt");
        if (!await io.confirm(`Delete Project ${id} with all its Tasks? [y/N] `)) throw new CliError("not deleted");
      }
      const body = await api().request<{ removed: { tasks: number; conditions: number; afters: number } }>(
        "DELETE", `/api/v1/projects/${encodeURIComponent(id)}`);
      print(options, body, ({ removed }) =>
        `Deleted ${id}: ${removed.tasks} Tasks, ${removed.conditions} Waiting conditions, ${removed.afters} Afters\n`);
    });

  return program;
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    await buildProgram(io).parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof CliError) {
      io.stderr(`Error: ${error.message}\n${error.hint ? `${error.hint}\n` : ""}`);
      return error.exitCode;
    }
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
