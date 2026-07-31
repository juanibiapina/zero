// How an inbound turn's user message text is assembled: an optional
// orchestrator note, then what the user actually said, then one marker per
// file saved with the message. Pure, so the ordering is testable without a DO.

// The introduction is an instruction, not fixed copy, because the same turn may
// also have to answer a question the user typed instead of pressing Start.
// The user's name comes from the pinned identity topic the Google onboarding
// scan fills (name first), which is rendered into the system prompt every turn.
// That scan is queued, so on the rare turn where it has not landed yet there is
// no name in context — hence the explicit "don't guess".
export const FIRST_CONTACT_NOTE =
  "[First contact: this person has just connected Zero and is opening this chat for the first time. Before anything else, introduce yourself in one short, warm message: greet them by name, say who you are and that you're here to help, that you remember things across conversations, and name a couple of concrete things you can do (email, calendar). Work in one specific thing you already know about them, so it is clear you are not starting from nothing. If you do not know their name, greet them without one rather than guessing. Then answer whatever they said, if anything.]";

export const composeTurnText = (input: {
  note?: string;
  text: string;
  markers?: string[];
}): string =>
  [input.note, input.text, ...(input.markers ?? [])]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
