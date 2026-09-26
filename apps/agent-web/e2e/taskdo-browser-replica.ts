import type { BrowserTaskdoReplica } from "../src/lib/browser-taskdo-replica";
import { openBrowserTaskdoReplica } from "../src/lib/browser-taskdo-replica";

declare global {
  interface Window {
    taskdoProof: {
      ready: Promise<void>;
      add: (text: string) => Promise<string[]>;
      close: () => Promise<void>;
      tasks: () => string[];
      state: () => { connected: boolean; durable: boolean; durabilityError: string | null };
    };
  }
}

const accountId = new URL(location.href).searchParams.get("account") ?? "browser-proof";
document.cookie = `zero_test_user=${encodeURIComponent(accountId)}; Path=/; SameSite=Lax`;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const taskList = document.querySelector<HTMLOListElement>("#tasks")!;
let replica: BrowserTaskdoReplica | undefined;
let connected = false;
let durable = false;
let durabilityError: string | null = null;

const render = () => {
  const tasks = replica?.snapshot().tasks ?? [];
  taskList.replaceChildren(...tasks.map((task) => {
    const item = document.createElement("li");
    item.textContent = `${task.id}:${task.text}`;
    return item;
  }));
  status.textContent = JSON.stringify({ accountId, connected, durable, durabilityError, tasks: tasks.length });
};

const ready = openBrowserTaskdoReplica(accountId, {
  onSnapshot: render,
  onConnection(value) {
    connected = value;
    render();
  },
  onDurability(value, error) {
    durable = value;
    durabilityError = error;
    render();
  },
}).then(async (opened) => {
  replica = opened;
  await Promise.all([
    opened.api.collection.preload(),
    opened.projectsApi.collection.preload(),
    opened.waitsApi.collection.preload(),
  ]);
  durable = opened.durable;
  durabilityError = opened.durabilityError;
  render();
});

window.taskdoProof = {
  ready,
  async add(text) {
    await ready;
    const transaction = replica!.api.add(text);
    await transaction.isPersisted.promise;
    return replica!.snapshot().tasks.map((task) => task.text).sort();
  },
  async close() {
    await ready;
    await replica!.close();
  },
  tasks: () => replica?.snapshot().tasks.map((task) => task.text).sort() ?? [],
  state: () => ({ connected, durable, durabilityError }),
};
