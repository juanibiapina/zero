// A Capture: one raw, untyped line dropped into the Inbox. The single shared
// entity type for the Capture data layer, used by web and mobile.
export type Capture = {
  id: string;
  text: string;
  createdAt: string;
  processedAt: string | null;
};
