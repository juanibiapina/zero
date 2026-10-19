import { safeRandomUUID } from "@tanstack/db";
import type { MergeableStore, Row } from "tinybase";

import { localToday } from "../tasks/today";

export const NIGHT_ENDS_AT = "08:00";
export const DEFAULT_OPENS_AT = "21:00";

const TABLE = "nights";
const DONE = "done:";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export type NightStep = { id: string; text: string };

export type Night = {
  night: string;
  steps: NightStep[];
  done: Record<string, string>;
  opensAt: string;
  wentToBedAt: string | null;
};

export type NightStepMark = NightStep & { doneAt: string | null };
export type DoneNightStep = NightStep & { doneAt: string };
export type PastNight = { night: string; steps: NightStepMark[]; wentToBedAt: string | null };
export type NightStepCount = { done: number; nights: number };

export type NightView = {
  night: string;
  state: "open" | "closed";
  opensAt: string;
  wentToBedAt: string | null;
  steps: NightStep[];
  open: NightStep[];
  done: DoneNightStep[];
  showIcon: boolean;
  nextChange: Date;
  history: PastNight[];
  counts: Record<string, NightStepCount>;
};

function clock(now: Date): string {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function addDays(night: string, days: number): string {
  const date = new Date(`${night}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localToday(date);
}

function at(day: string, time: string): Date {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date(`${day}T12:00:00`);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

export function nightOf(now: Date): string {
  const today = localToday(now);
  return clock(now) < NIGHT_ENDS_AT ? addDays(today, -1) : today;
}

function readSteps(value: unknown): NightStep[] | null {
  if (typeof value !== "string") return null;
  try {
    const steps: unknown = JSON.parse(value);
    if (!Array.isArray(steps)) return null;
    const valid = steps.every((step: unknown) => typeof step === "object" && step !== null
      && typeof (step as NightStep).id === "string" && typeof (step as NightStep).text === "string");
    return valid ? (steps as NightStep[]).map(({ id, text }) => ({ id, text })) : null;
  } catch {
    return null;
  }
}

function readNight(night: string, row: Row): Night | null {
  const steps = readSteps(row.steps);
  if (!steps) return null;
  const done: Record<string, string> = {};
  for (const [cell, value] of Object.entries(row)) {
    if (cell.startsWith(DONE) && typeof value === "string") done[cell.slice(DONE.length)] = value;
  }
  return {
    night,
    steps,
    done,
    opensAt: typeof row.opensAt === "string" && validOpensAt(row.opensAt) ? row.opensAt : DEFAULT_OPENS_AT,
    wentToBedAt: typeof row.wentToBedAt === "string" ? row.wentToBedAt : null,
  };
}

function validOpensAt(time: string): boolean {
  return TIME.test(time) && time >= NIGHT_ENDS_AT;
}

export function readNights(store: MergeableStore): Night[] {
  return store.getRowIds(TABLE)
    .flatMap((night) => {
      const read = readNight(night, store.getRow(TABLE, night));
      return read ? [read] : [];
    })
    .sort((a, b) => a.night.localeCompare(b.night));
}

function tonightOf(nights: Night[], night: string): Night {
  const own = nights.find((candidate) => candidate.night === night);
  if (own) return own;
  const template = nights.filter((candidate) => candidate.night < night).at(-1);
  return { night, steps: template?.steps ?? [], done: {}, opensAt: template?.opensAt ?? DEFAULT_OPENS_AT, wentToBedAt: null };
}

function nextChangeAfter(now: Date, opensAt: string): Date {
  const today = localToday(now);
  const time = clock(now);
  if (time < NIGHT_ENDS_AT) return at(today, NIGHT_ENDS_AT);
  if (time < opensAt) return at(today, opensAt);
  return at(addDays(today, 1), NIGHT_ENDS_AT);
}

function countsFor(nights: Night[], tonight: Night): Record<string, NightStepCount> {
  const all = [...nights.filter((night) => night.night < tonight.night), tonight];
  const counts: Record<string, NightStepCount> = {};
  for (const step of tonight.steps) {
    const first = all.find((night) => night.steps.some((candidate) => candidate.id === step.id))?.night ?? tonight.night;
    const weekStart = addDays(tonight.night, -6);
    const from = first > weekStart ? first : weekStart;
    let nightsCounted = 0;
    for (let night = from; night <= tonight.night; night = addDays(night, 1)) nightsCounted += 1;
    const done = all.filter((night) => night.night >= from && night.done[step.id] != null).length;
    counts[step.id] = { done, nights: nightsCounted };
  }
  return counts;
}

export function nightView(nights: Night[], now: Date): NightView {
  const tonight = tonightOf(nights, nightOf(now));
  const state = tonight.wentToBedAt ? "closed" : "open";
  const time = clock(now);
  const evening = time >= tonight.opensAt || time < NIGHT_ENDS_AT;
  return {
    night: tonight.night,
    state,
    opensAt: tonight.opensAt,
    wentToBedAt: tonight.wentToBedAt,
    steps: tonight.steps,
    open: tonight.steps.filter((step) => tonight.done[step.id] == null),
    done: tonight.steps.flatMap((step) => {
      const doneAt = tonight.done[step.id];
      return doneAt == null ? [] : [{ ...step, doneAt }];
    }),
    showIcon: state === "open" && evening && tonight.steps.length > 0,
    nextChange: nextChangeAfter(now, tonight.opensAt),
    history: nights
      .filter((night) => night.night < tonight.night)
      .reverse()
      .map((night) => ({
        night: night.night,
        steps: night.steps.map((step) => ({ ...step, doneAt: night.done[step.id] ?? null })),
        wentToBedAt: night.wentToBedAt,
      })),
    counts: countsFor(nights, tonight),
  };
}

export class NightRoutineModel {
  constructor(
    private readonly store: MergeableStore,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = safeRandomUUID,
  ) {}

  view(): NightView {
    return nightView(readNights(this.store), this.now());
  }

  addStep(text: string): NightStep {
    const step = { id: this.newId(), text: this.validText(text) };
    const tonight = this.openTonight();
    this.writeSteps(tonight.night, [...tonight.steps, step]);
    return step;
  }

  renameStep(id: string, text: string): void {
    const tonight = this.openTonight();
    const trimmed = this.validText(text);
    this.writeSteps(tonight.night, tonight.steps.map((step) => step.id === id ? { ...step, text: trimmed } : step));
  }

  removeStep(id: string): void {
    const tonight = this.openTonight();
    this.writeSteps(tonight.night, tonight.steps.filter((step) => step.id !== id));
    this.store.delCell(TABLE, tonight.night, `${DONE}${id}`);
  }

  moveStep(id: string, toIndex: number): void {
    const tonight = this.openTonight();
    const moving = tonight.steps.find((step) => step.id === id);
    if (!moving) return;
    const rest = tonight.steps.filter((step) => step.id !== id);
    const open = rest.filter((step) => tonight.done[step.id] == null);
    const anchor = open[toIndex];
    const position = anchor
      ? rest.indexOf(anchor)
      : open.length > 0 ? rest.indexOf(open.at(-1)!) + 1 : rest.length;
    this.writeSteps(tonight.night, [...rest.slice(0, position), moving, ...rest.slice(position)]);
  }

  complete(id: string): void {
    const tonight = this.openTonight();
    if (!tonight.steps.some((step) => step.id === id)) throw new Error("Step not found");
    this.ensureRow(tonight);
    if (tonight.done[id] == null) this.store.setCell(TABLE, tonight.night, `${DONE}${id}`, this.now().toISOString());
  }

  uncomplete(id: string): void {
    const tonight = this.openTonight();
    this.store.delCell(TABLE, tonight.night, `${DONE}${id}`);
  }

  setOpensAt(time: string): void {
    if (!validOpensAt(time)) throw new Error(`Choose a time from ${NIGHT_ENDS_AT} to 23:59`);
    const tonight = this.openTonight();
    this.ensureRow(tonight);
    this.store.setCell(TABLE, tonight.night, "opensAt", time);
  }

  goToBed(): string {
    const tonight = this.openTonight();
    this.ensureRow(tonight);
    this.store.setCell(TABLE, tonight.night, "wentToBedAt", this.now().toISOString());
    return tonight.night;
  }

  undoBed(night: string): void {
    if (this.store.hasRow(TABLE, night)) this.store.delCell(TABLE, night, "wentToBedAt");
  }

  private openTonight(): Night {
    const tonight = tonightOf(readNights(this.store), nightOf(this.now()));
    if (tonight.wentToBedAt) throw new Error("Tonight's routine is over");
    return tonight;
  }

  private ensureRow(tonight: Night): void {
    if (readSteps(this.store.getCell(TABLE, tonight.night, "steps"))) return;
    this.store.setCell(TABLE, tonight.night, "steps", JSON.stringify(tonight.steps));
    this.store.setCell(TABLE, tonight.night, "opensAt", tonight.opensAt);
  }

  private writeSteps(night: string, steps: NightStep[]): void {
    const tonight = tonightOf(readNights(this.store), night);
    this.ensureRow(tonight);
    this.store.setCell(TABLE, night, "steps", JSON.stringify(steps));
  }

  private validText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Write a step");
    return trimmed;
  }
}
