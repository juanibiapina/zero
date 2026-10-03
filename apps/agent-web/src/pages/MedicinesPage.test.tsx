import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it } from "vitest";
import { createInMemoryTodoData } from "@/testing/in-memory-todo-data";
import { TodoDataContextProvider } from "@/lib/todo-data";
import { medicineToday, medicineEndDate, type TaskdoReplica } from "@zero/agent-core";
import { MedicinesPage } from "./MedicinesPage";

let replica: TaskdoReplica;
afterEach(async () => { cleanup(); await replica.close(); });

it("starts a once-daily medicine with a one-hour reminder", async () => {
  const todo = createInMemoryTodoData();
  replica = todo.replica;
  render(<TodoDataContextProvider value={{ ...todo.data, authenticatedFeatures: false }}>
    <MemoryRouter><MedicinesPage /></MemoryRouter>
  </TodoDataContextProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Add medicine" }));
  expect(screen.getByLabelText("Alarm 1")).toHaveValue("20:00");
  expect(screen.getByLabelText("Remind from 1")).toHaveValue("19:00");
});

it("adds a third dose with a thirty-minute reminder and preserves edited reminder times", async () => {
  const todo = createInMemoryTodoData();
  replica = todo.replica;
  render(<TodoDataContextProvider value={{ ...todo.data, authenticatedFeatures: false }}>
    <MemoryRouter><MedicinesPage /></MemoryRouter>
  </TodoDataContextProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Add medicine" }));
  fireEvent.change(screen.getByLabelText("Remind from 1"), { target: { value: "18:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Add dose time" }));
  fireEvent.click(screen.getByRole("button", { name: "Add dose time" }));
  expect(screen.getByLabelText("Remind from 1")).toHaveValue("18:00");
  expect(screen.getByLabelText("Alarm 3")).toHaveValue("14:00");
  expect(screen.getByLabelText("Remind from 3")).toHaveValue("13:30");
});

it("creates a finite multi-dose course and records, undoes, and retains independent history", async () => {
  const todo = createInMemoryTodoData();
  replica = todo.replica;
  render(<TodoDataContextProvider value={{ ...todo.data, authenticatedFeatures: false }}>
    <MemoryRouter initialEntries={["/medicines"]}><Routes>
      <Route path="/medicines" element={<MedicinesPage />} />
      <Route path="/medicines/:id" element={<MedicinesPage />} />
    </Routes></MemoryRouter>
  </TodoDataContextProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Add medicine" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Medicine name" }), { target: { value: "Daily pill" } });
  fireEvent.change(screen.getByLabelText("Alarm 1"), { target: { value: "22:00" } });
  fireEvent.click(screen.getByRole("radio", { name: "Number of days" }));
  fireEvent.click(screen.getByRole("button", { name: "Add dose time" }));
  fireEvent.change(screen.getByLabelText("Alarm 2"), { target: { value: "23:00" } });
  fireEvent.change(screen.getByLabelText("Remind from 2"), { target: { value: "21:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save medicine" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(replica.snapshot().medicines[0]?.endsOn).toBe(medicineEndDate(medicineToday(), 10));
  fireEvent.click(await screen.findByRole("button", { name: "Taken 22:00 dose" }));
  await waitFor(() => expect(replica.snapshot().doses[0]?.takenAt).toBeTruthy());
  expect(screen.getByRole("button", { name: "Taken 23:00 dose" })).toBeVisible();
  expect(await screen.findByText(/Scheduled 22:00/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Taken 23:00 dose" }));
  await waitFor(() => expect(replica.snapshot().doses.filter((dose) => dose.takenAt)).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "Undo last taken dose" }));
  await waitFor(() => expect(replica.snapshot().doses.filter((dose) => dose.takenAt)).toHaveLength(1));
  expect(screen.getByRole("button", { name: "Taken 23:00 dose" })).toBeVisible();
  await act(async () => { await replica.medicines.edit(replica.snapshot().medicines[0].id, { ...replica.snapshot().medicines[0], doses: [{ id: replica.snapshot().medicines[0].doses[0].id, remindAt: "19:00", alarmAt: "21:30" }] }); });
  expect(screen.getByText(/Scheduled 22:00/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Pause reminders" }));
  expect(await screen.findByRole("button", { name: "Resume reminders" })).toBeVisible();
});
