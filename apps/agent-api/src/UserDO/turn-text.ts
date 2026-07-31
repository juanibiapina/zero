// How an inbound turn's user message text is assembled: an optional
// orchestrator note, then what the user actually said, then one marker per
// file saved with the message. Pure, so the ordering is testable without a DO.

export const FIRST_CONTACT_NOTE =
  "[First contact: this person has just connected Zero and is opening this chat for the first time. Before anything else, introduce yourself in one short message: who you are, that you remember things across conversations in topics, and one concrete thing you can do for them drawn from what you already know about them. Then answer whatever they said, if anything.]";

export const composeTurnText = (input: {
  note?: string;
  text: string;
  markers?: string[];
}): string =>
  [input.note, input.text, ...(input.markers ?? [])]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
