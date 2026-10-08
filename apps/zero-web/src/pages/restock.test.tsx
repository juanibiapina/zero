import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { defaultToastController, MedicineDraft, medicineToday, type TaskdoReplica } from "@zero/agent-core";
import { TodoDataContextProvider } from "@/lib/todo-data";
import { createInMemoryTodoData } from "@/testing/in-memory-todo-data";
import { HomePage } from "./HomePage";
import { MedicinesPage } from "./MedicinesPage";

const opened: TaskdoReplica[] = [];
async function open(path: string) {
  const todo = createInMemoryTodoData();
  opened.push(todo.replica);
  const medicine = await todo.replica.medicines.add(MedicineDraft.create(medicineToday()).change({ name: "Ibuprofen" }).commit());
  render(<TodoDataContextProvider value={{ ...todo.data, authenticatedFeatures: false }}><MemoryRouter initialEntries={[path.replace(":id", medicine.id)]}><Routes>
    <Route path="/home" element={<HomePage />} />
    <Route path="/medicines/:id" element={<MedicinesPage />} />
  </Routes></MemoryRouter></TodoDataContextProvider>);
  return { replica: todo.replica, medicine };
}
afterEach(async () => {
  cleanup();
  defaultToastController.dismiss();
  await Promise.all(opened.splice(0).map((replica) => replica.close()));
});

describe("restock Tasks", () => {
  async function lowOnHome() {
    const opened = await open("/home");
    await act(async () => { await opened.replica.medicines.setSupply(opened.medicine.id, { pillsLeft: 4, leadDays: 14 }); });
    return opened;
  }
  const restockTask = (replica: TaskdoReplica) => replica.snapshot().tasks.find((task) => task.parent?.kind === "medicine");

  it("asks how many pills were bought before completing the Task", async () => {
    const { replica } = await lowOnHome();
    expect(await screen.findByText("💊")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: 'Complete "Buy Ibuprofen"' }));
    const amount = await screen.findByRole("spinbutton", { name: "How many pills did you get?" });
    expect(restockTask(replica)?.completedAt).toBeNull();
    fireEvent.change(amount, { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(replica.snapshot().medicines[0].supply).toMatchObject({ pillsLeft: 64, refill: 60 }));
    expect(replica.snapshot().tasks.filter((task) => !task.completedAt)).toEqual([]);
    expect(defaultToastController.getSnapshot()[0]?.message).toBe("Restocked 60 pills");
  });

  it("changes nothing when the sheet is canceled", async () => {
    const { replica } = await lowOnHome();
    fireEvent.click(await screen.findByRole("button", { name: 'Complete "Buy Ibuprofen"' }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("spinbutton", { name: "How many pills did you get?" })).toBeNull());
    expect(restockTask(replica)?.completedAt).toBeNull();
    expect(replica.snapshot().medicines[0].supply?.pillsLeft).toBe(4);
  });

  it("shows the Medicine in place of the Project picker", async () => {
    await lowOnHome();
    fireEvent.click(await screen.findByRole("button", { name: 'Edit "Buy Ibuprofen"' }));
    expect(await screen.findByRole("button", { name: "Open medicine Ibuprofen" })).toHaveTextContent("For Ibuprofen");
    expect(screen.queryByRole("button", { name: "Project" })).toBeNull();
  });

  it("sets the count from the Medicine page", async () => {
    const { replica } = await open("/medicines/:id");
    expect(await screen.findByText("Pills not counted")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Set count" }));
    fireEvent.change(await screen.findByRole("spinbutton", { name: "How many pills do you have?" }), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("60 pills left · about 60 days")).toBeVisible();
    expect(restockTask(replica)).toBeUndefined();
  });
});
