import { safeRandomUUID } from "@tanstack/db";
import { EVERY_DAY, medicineEndDate, medicineLead, validateMedicine, type MedicineInput, type MedicineSlot, type Weekday } from "./model";

const DAILY_TIMES: Record<number, string[]> = {
  1: ["20:00"],
  2: ["08:00", "20:00"],
  3: ["08:00", "14:00", "20:00"],
  4: ["08:00", "12:00", "16:00", "20:00"],
};
export type MedicineCourse = { kind: "ongoing" } | { kind: "days"; days: string } | { kind: "last-day"; on: string };
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const defaultLead = (count: number) => count === 1 ? 60 : count === 3 ? 30 : 15;
const reminder = (time: string, lead: number) => clock((((minutes(time) - lead) % 1440) + 1440) % 1440);

export class MedicineDraft {
  private constructor(
    readonly input: MedicineInput,
    readonly course: MedicineCourse,
    readonly changed = false,
  ) {}

  static create(today: string, source?: MedicineInput, copy = false): MedicineDraft {
    const input: MedicineInput = source ? {
      ...source,
      startsOn: copy ? today : source.startsOn,
      endsOn: copy ? null : source.endsOn,
      paused: copy ? false : source.paused,
      doses: source.doses.map((slot) => ({ ...slot, id: copy ? safeRandomUUID() : slot.id })),
    } : {
      name: "", instructions: null, startsOn: today, endsOn: null, paused: false, weekdays: EVERY_DAY,
      doses: [{ id: safeRandomUUID(), alarmAt: "20:00", remindAt: reminder("20:00", defaultLead(1)), amount: 1 }],
    };
    return new MedicineDraft(input, input.endsOn ? { kind: "last-day", on: input.endsOn } : { kind: "ongoing" });
  }

  change(fields: Partial<Pick<MedicineInput, "name" | "instructions" | "startsOn">>): MedicineDraft {
    return new MedicineDraft({ ...this.input, ...fields }, this.course, true);
  }

  frequency(count: number): MedicineDraft {
    const times = DAILY_TIMES[count];
    if (!times) throw new Error("Choose one to four daily times, or customize the schedule");
    const matching = new Map(this.input.doses.filter((slot) => times.includes(slot.alarmAt)).map((slot) => [slot.alarmAt, slot]));
    const remaining = this.input.doses.filter((slot) => !times.includes(slot.alarmAt));
    const doses = times.map((alarmAt) => {
      const kept = matching.get(alarmAt) ?? remaining.shift();
      return { id: kept?.id ?? safeRandomUUID(), alarmAt, remindAt: reminder(alarmAt, defaultLead(count)), amount: kept?.amount ?? 1 };
    });
    return new MedicineDraft({ ...this.input, doses }, this.course, true);
  }

  time(slotId: string, key: "alarmAt" | "remindAt", value: string): MedicineDraft {
    const doses = this.input.doses.map((slot) => {
      if (slot.id !== slotId) return slot;
      if (key === "remindAt") return { ...slot, remindAt: value };
      return { ...slot, alarmAt: value, remindAt: reminder(value, medicineLead(slot)) };
    });
    return new MedicineDraft({ ...this.input, doses }, this.course, true);
  }

  heads(slotId: string, lead: number): MedicineDraft {
    if (!Number.isInteger(lead) || lead < 1 || lead > 1439) return this;
    const doses = this.input.doses.map((slot) => slot.id === slotId ? { ...slot, remindAt: reminder(slot.alarmAt, lead) } : slot);
    return new MedicineDraft({ ...this.input, doses }, this.course, true);
  }

  amount(slotId: string, value: number): MedicineDraft {
    if (!Number.isInteger(value) || value < 1) return this;
    const doses = this.input.doses.map((slot) => slot.id === slotId ? { ...slot, amount: value } : slot);
    return new MedicineDraft({ ...this.input, doses }, this.course, true);
  }

  addTime(): MedicineDraft {
    const occupied = new Set(this.input.doses.map((slot) => slot.alarmAt));
    const alarmAt = [...DAILY_TIMES[3], "12:00", "16:00", ...Array.from({ length: 23 }, (_, index) => [clock((index + 1) * 60), clock((index + 1) * 60 + 30)]).flat()].find((time) => !occupied.has(time));
    if (!alarmAt || this.input.doses.length >= 24) throw new Error("A medicine supports up to 24 daily times");
    const slot: MedicineSlot = { id: safeRandomUUID(), alarmAt, remindAt: reminder(alarmAt, defaultLead(this.input.doses.length + 1)), amount: 1 };
    return new MedicineDraft({ ...this.input, doses: [...this.input.doses, slot] }, this.course, true);
  }

  removeTime(slotId: string): MedicineDraft {
    if (this.input.doses.length <= 1) return this;
    return new MedicineDraft({ ...this.input, doses: this.input.doses.filter((slot) => slot.id !== slotId) }, this.course, true);
  }

  toggleWeekday(day: Weekday): MedicineDraft {
    const chosen = this.input.weekdays.includes(day);
    if (chosen && this.input.weekdays.length === 1) return this;
    const weekdays = chosen ? this.input.weekdays.filter((item) => item !== day) : [...this.input.weekdays, day].sort((a, b) => a - b);
    return new MedicineDraft({ ...this.input, weekdays }, this.course, true);
  }

  withCourse(course: MedicineCourse): MedicineDraft {
    return new MedicineDraft(this.input, course, true);
  }

  get endsOn(): string | null {
    if (this.course.kind === "ongoing") return null;
    if (this.course.kind === "last-day") return this.course.on;
    return medicineEndDate(this.input.startsOn, Number(this.course.days));
  }

  commit(): MedicineInput {
    const input = {
      ...this.input, name: this.input.name.trim(),
      instructions: this.input.instructions?.trim() || null,
      endsOn: this.endsOn,
      weekdays: [...this.input.weekdays],
      doses: this.input.doses.map((slot) => ({ ...slot })),
    };
    validateMedicine(input);
    return input;
  }
}
