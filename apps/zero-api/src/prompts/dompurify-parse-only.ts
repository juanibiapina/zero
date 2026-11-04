// Mermaid imports DOMPurify, which needs a browser window and fails on load in
// a Worker. The Worker only parses diagrams and never renders them, so it gets
// this stand-in: sanitizing returns the text unchanged and hooks do nothing.
// vite.config.ts aliases "dompurify" to this file.
const purify = {
  isSupported: false,
  sanitize: (dirty: unknown) => String(dirty),
  addHook: () => {},
  removeHook: () => {},
  removeHooks: () => {},
  removeAllHooks: () => {},
  setConfig: () => {},
  clearConfig: () => {},
};

export default purify;
