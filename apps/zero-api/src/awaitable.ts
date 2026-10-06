// A port that is synchronous over the local store and asynchronous when the
// store lives in another Durable Object, reached over RPC.
export type Awaitable<T> = T | Promise<T>;

// A method that always returns a promise keeps it; one that returns an
// `Awaitable` loses the promise branch.
type SettledReturn<R> = [R] extends [Promise<unknown>]
  ? R
  : Exclude<R, Promise<unknown>>;

// The synchronous shape of such a port: what a local adapter returns, so its
// direct callers keep plain values.
export type Settled<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => SettledReturn<R>
    : T[K];
};
