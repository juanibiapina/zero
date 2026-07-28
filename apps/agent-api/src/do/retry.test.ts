import { describe, it, expect, vi } from "vitest";
import { withDORetry, isDOError, isDurableObjectReset } from "./retry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const retryableError = (msg = "DO reset") => {
  const err = new Error(msg);
  (err as Error & { retryable: boolean }).retryable = true;
  return err;
};

const overloadedError = (msg = "DO overloaded") => {
  const err = new Error(msg);
  (err as Error & { overloaded: boolean }).overloaded = true;
  return err;
};

interface FakeStub {
  greet(name: string): Promise<string>;
  label: string;
}

const fakeStub = (
  handler: (name: string) => Promise<string>,
  label = "stub",
): FakeStub => ({
  greet: handler,
  label,
});

// ---------------------------------------------------------------------------
// isDOError
// ---------------------------------------------------------------------------

describe("isDOError", () => {
  it("returns true for Error instances", () => {
    expect(isDOError(new Error("boom"))).toBe(true);
  });

  it("returns false for non-Error values", () => {
    expect(isDOError("string")).toBe(false);
    expect(isDOError(null)).toBe(false);
    expect(isDOError(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDurableObjectReset
// ---------------------------------------------------------------------------

const RESET_STRING = "Durable Object reset because its code was updated";

describe("isDurableObjectReset", () => {
  it("returns true when durableObjectReset === true", () => {
    const err = Object.assign(new Error("boom"), {
      durableObjectReset: true,
      retryable: true,
    });
    expect(isDurableObjectReset(err)).toBe(true);
  });

  it("returns true when the message contains the reset string", () => {
    expect(isDurableObjectReset(new Error(`${RESET_STRING}.`))).toBe(true);
  });

  it("returns false for a plain Error", () => {
    expect(isDurableObjectReset(new Error("gateway down"))).toBe(false);
  });

  it("returns false for a bare retryable error without the reset marker", () => {
    expect(isDurableObjectReset(retryableError("network drop"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isDurableObjectReset("string")).toBe(false);
    expect(isDurableObjectReset(undefined)).toBe(false);
    expect(isDurableObjectReset(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withDORetry
// ---------------------------------------------------------------------------

describe("withDORetry", () => {
  it("proxies successful method calls", async () => {
    const stub = fakeStub(async (name) => `hello ${name}`);
    const proxy = withDORetry(() => stub);

    const result = await proxy.greet("world");
    expect(result).toBe("hello world");
  });

  it("passes through non-function properties", () => {
    const stub = fakeStub(async () => "ok", "my-label");
    const proxy = withDORetry(() => stub);

    expect(proxy.label).toBe("my-label");
  });

  it("retries on retryable error and succeeds", async () => {
    let attempt = 0;
    const getStub = vi.fn(() =>
      fakeStub(async (name) => {
        attempt++;
        if (attempt === 1) throw retryableError();
        return `hello ${name}`;
      }),
    );
    const proxy = withDORetry(getStub);

    const result = await proxy.greet("world");
    expect(result).toBe("hello world");
    expect(attempt).toBe(2);
  });

  it("gets a fresh stub on each retry", async () => {
    let attempt = 0;
    const getStub = vi.fn(() =>
      fakeStub(async (name) => {
        attempt++;
        if (attempt === 1) throw retryableError();
        return `hello ${name}`;
      }),
    );
    const proxy = withDORetry(getStub);

    await proxy.greet("world");
    // Initial call + one refresh
    expect(getStub).toHaveBeenCalledTimes(2);
  });

  it("throws after max attempts exhausted", async () => {
    const getStub = vi.fn(() =>
      fakeStub(async () => {
        throw retryableError();
      }),
    );
    const proxy = withDORetry(getStub);

    await expect(proxy.greet("world")).rejects.toThrow("DO reset");
    // Initial + 2 refreshes = 3 total
    expect(getStub).toHaveBeenCalledTimes(3);
  });

  it("does not retry on overloaded", async () => {
    let attempts = 0;
    const getStub = vi.fn(() =>
      fakeStub(async () => {
        attempts++;
        throw overloadedError();
      }),
    );
    const proxy = withDORetry(getStub);

    await expect(proxy.greet("world")).rejects.toThrow("DO overloaded");
    expect(attempts).toBe(1);
  });

  it("does not retry non-retryable errors", async () => {
    let attempts = 0;
    const getStub = vi.fn(() =>
      fakeStub(async () => {
        attempts++;
        throw new Error("some other error");
      }),
    );
    const proxy = withDORetry(getStub);

    await expect(proxy.greet("world")).rejects.toThrow("some other error");
    expect(attempts).toBe(1);
  });
});
