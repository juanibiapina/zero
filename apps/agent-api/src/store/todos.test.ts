import { describe, expect, it } from "vitest";
import { createDb } from "do-orm";
import { createMockStorage } from "do-orm/src/test-utils";

import { DbTodoStore } from "./todos";

// A DbTodoStore over do-orm's in-memory mock storage. The mock creates tables
// lazily on first insert, so no migration run is needed here; this exercises the
// store's add/list SQL against an in-memory table.
const makeStore = () => new DbTodoStore(createDb(createMockStorage()));

describe("DbTodoStore", () => {
  it("stores an added todo and returns it with an id", () => {
    const store = makeStore();

    const todo = store.add("buy milk");

    expect(todo.id).toBeTruthy();
    expect(todo.text).toBe("buy milk");
    expect(store.list()).toEqual([todo]);
  });

  it("lists todos in capture order (oldest first)", () => {
    const store = makeStore();

    const first = store.add("first");
    const second = store.add("second");

    expect(store.list()).toEqual([first, second]);
  });

  it("starts empty", () => {
    expect(makeStore().list()).toEqual([]);
  });
});
