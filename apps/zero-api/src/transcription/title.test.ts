import { describe, expect, it, vi } from "vitest";

import { createTitler, type TitleWriter } from "./title";

const writing = (title: string): TitleWriter => ({ model: "titles", write: async () => title });

describe("titler", () => {
  it("asks the writer for a title from the transcript text", async () => {
    const write = vi.fn(async () => "Call Ana on Friday");

    expect(await createTitler({ model: "titles", write })("Call Ana on Friday about the boiler.")).toBe("Call Ana on Friday");
    expect(write).toHaveBeenCalledWith("Call Ana on Friday about the boiler.");
  });

  it("gives no title for a note with no words, without asking the writer", async () => {
    const write = vi.fn(async () => "Silence");

    expect(await createTitler({ model: "titles", write })("  ...  ")).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("tidies quotes, a label, a final period and extra lines from the answer", async () => {
    const title = (answer: string) => createTitler(writing(answer))("Call Ana.");

    expect(await title('"Call Ana."')).toBe("Call Ana");
    expect(await title("Title: Call Ana")).toBe("Call Ana");
    expect(await title("\n  Call   Ana  \nThis note is about Ana.")).toBe("Call Ana");
    expect(await title("Ligar para a Ana")).toBe("Ligar para a Ana");
  });

  it("gives no title when the answer is empty or too long to be one", async () => {
    const title = (answer: string) => createTitler(writing(answer))("Call Ana.");

    expect(await title("")).toBeNull();
    expect(await title('"."')).toBeNull();
    expect(await title("This voice note is about calling Ana on Friday to ask about the boiler")).toBeNull();
    expect(await title("x".repeat(81))).toBeNull();
  });

  it("lets a writer failure reach the caller", async () => {
    const titler = createTitler({ model: "titles", write: async () => { throw new Error("down"); } });

    await expect(titler("Call Ana.")).rejects.toThrow("down");
  });
});
