import { markdownToTelegramHtml } from "./markdown";

const MAX_MESSAGE_LENGTH = 4096;

export type SendFn = (
  text: string,
  parseMode?: "HTML",
) => Promise<unknown>;

export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    const onNewline = splitAt > 0;
    if (!onNewline) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(onNewline ? splitAt + 1 : splitAt);
  }

  return chunks;
}

/**
 * Convert markdown to Telegram HTML, split into chunks, and send.
 * Falls back to plain text (tags stripped) on Telegram 400 errors.
 */
export async function formatAndSend(
  markdown: string,
  send: SendFn,
): Promise<void> {
  let html: string;
  let useHtml: boolean;

  try {
    html = markdownToTelegramHtml(markdown);
    useHtml = true;
  } catch {
    html = markdown;
    useHtml = false;
  }

  const chunks = splitMessage(html, MAX_MESSAGE_LENGTH);

  for (const chunk of chunks) {
    try {
      await send(chunk, useHtml ? "HTML" : undefined);
    } catch (err: unknown) {
      if (
        useHtml &&
        typeof err === "object" &&
        err !== null &&
        "error_code" in err &&
        (err as { error_code: number }).error_code === 400
      ) {
        // Telegram couldn't parse our HTML — strip tags and retry as plain text
        const plain = chunk.replace(/<[^>]+>/g, "");
        await send(plain, undefined);
      } else {
        throw err;
      }
    }
  }
}
