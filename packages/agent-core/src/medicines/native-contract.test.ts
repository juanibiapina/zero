import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryTaskdoReplica } from "../taskdo/in-memory";
import { medicineOccurrences, type Dose, type Medicine, type MedicineReceipt } from "./model";

type OccurrenceCase = { name: string; zone: string; now: string; on: string; medicine: Medicine; doses: Omit<Dose, "takenAt">[] };
type ReceiptContract = { zone: string; medicine: Medicine; takenAt: string; receipts: MedicineReceipt[] };

const fixture = <T>(name: string) => JSON.parse(readFileSync(new URL(`./native-contract/${name}`, import.meta.url), "utf8")) as T;
const { cases } = fixture<{ cases: OccurrenceCase[] }>("occurrences.json");
const contract = fixture<ReceiptContract>("receipts.json");
const asInstants = (doses: Omit<Dose, "takenAt">[]) => doses.map((dose) => ({ ...dose, scheduledAt: Date.parse(dose.scheduledAt) }));

const zone = process.env.TZ;
afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

describe("native reminder contract", () => {
  it.each(cases)("plans the same doses as Android: $name", ({ zone, on, medicine, doses }) => {
    process.env.TZ = zone;
    const planned = medicineOccurrences(medicine, on).map(({ id, medicineId, slotId, on, scheduledAt }) => ({ id, medicineId, slotId, on, scheduledAt }));
    expect(asInstants(planned)).toEqual(asInstants(doses));
  });

  it("records the presented and taken receipts Android writes", async () => {
    process.env.TZ = contract.zone;
    const replica = createInMemoryTaskdoReplica();
    const { id, createdAt: _createdAt, ...input } = contract.medicine;
    await replica.medicines.add(input, id);
    await replica.medicines.applyReceipts(contract.receipts, "workspace");
    const taken = contract.receipts.find((receipt) => receipt.kind === "taken")!;
    const doses = replica.snapshot().doses;
    expect(doses.map((dose) => ({ id: dose.id, takenAt: dose.takenAt, scheduledAt: Date.parse(dose.scheduledAt) })))
      .toEqual([{ id: taken.id, takenAt: contract.takenAt, scheduledAt: Date.parse(taken.scheduledAt) }]);
    await replica.close();
  });
});
