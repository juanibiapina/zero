# Recording

## What it is

A Recording is a voice note you capture on the phone: one tap on the home
screen widget or on the mic button on Home starts it, and Stop saves it. "Call
the plumber about the boiler, ask for Thursday" said while walking is one
Recording. Each one keeps when it started, the phone's time zone at that
moment, how long it ran, where you started it, and which phone holds the audio.
A few seconds after it is saved, it also gets a transcript: what you said,
written as you meant it, with filler words removed and your spoken corrections
applied ("Thursday, no, Friday" becomes "Friday").

## Why it is its own block

A thought you say is captured before it is typed or sorted. The Recording keeps
the facts that cannot be recovered later, above all the moment it was said, so
transcription and other blocks can build on it afterwards.

## Rules

- Recording starts as soon as the recorder opens, without a second tap.
- Stop, Back and the Stop button in the recording notification all save the
  Recording. It keeps recording with the screen off or in another app.
- A saved Recording never changes, except that its transcript is added once.
- The phone that holds the audio sends it to the server for its transcript
  right after saving, and again when the app returns or reconnects if that
  failed. The server passes the audio to the transcription provider and keeps
  only the text.
- The transcript is cleaned up from the verbatim words, which are kept with
  it. A cleanup that drops most of a long note, or adds words, is discarded,
  and the verbatim words are shown instead. A silent note gets no text.
- Holding a Recording offers Delete, which asks first and then removes it from
  every device. The phone that holds the audio deletes it, at once or the next
  time it syncs. A Recording from another phone says so before you delete it.
- The audio stays on the phone that recorded it. Its details sync to every
  device.
- A recording cut off by Android closing the app is lost.

## How it looks

A mic button in Home's header, left of the 🌙 button, and a 1×1 red mic widget
for the home screen. Both open the recorder: a running time and a large red
Stop button. Saving shows "Saved · 0:42" on Home.

Browse lists Recordings, newest first, with the date and time where it was
recorded, up to four lines of its transcript, and the duration. A note still
waiting for its transcript on the phone that holds it says "Transcribing…",
and a silent one says "No speech". Tapping one plays it, and tapping again
pauses. A Recording made on another phone shows "On Pixel 7" and does not
play. Holding one opens a menu with its date and time, its whole transcript,
and Delete recording; for a Recording from another phone the menu adds
"Recorded on Pixel 7. Its audio isn't on this phone."

## Interactions

- Task, Project, Waiting, After, Medicine, Night routine: none, on purpose.
- Agents: read Recordings and their transcripts over MCP, with the date and
  time where each was recorded. They cannot delete one.

## Left out on purpose

- Location.
- Renaming or sharing a Recording, and seeking inside one.
- Recordings on the web.

## Ideas

- Upload the audio and stream it on other devices.
