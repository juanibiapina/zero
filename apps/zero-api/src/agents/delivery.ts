// At-most-once delivery of persisted assistant text.
//
// A response is written to the log before any of its text reaches Telegram, so
// the only thing that can be lost is the send. Each text block is claimed
// durably before it goes out: the first claim wins, a resumed run finds the
// claim and stays quiet. That makes an interrupted turn recoverable without
// risking a duplicate message.
//
// It lives outside the interface agent because two callers need it. The
// interface delivers blocks as the model produces them, and the orchestrator
// delivers what an interrupted run persisted but never sent — including the
// case where the response was terminal, so there is nothing left to ask the
// model and the reply would otherwise never be sent at all.

import { log } from "../log";
import { unclaimedBlockIndexes } from "../store/messages";
import type { Message } from "../store/types";
import { toBlocks } from "../store/messages";

export interface DeliveryInput {
  // Claim one block for delivery: true the first time, false if already sent.
  claim: (messageId: number, blockIndex: number) => boolean;
  send: (text: string) => Promise<void>;
  // Called for each block actually sent, in order. The interface uses it to
  // collect the turn's replies.
  onSent?: (text: string) => void;
}

export interface Delivery {
  // Send one block of a persisted response. Without a reference (a row that was
  // never persisted) there is nothing to claim and the text is sent as is.
  deliver: (
    text: string,
    ref?: { messageId: number | null; blockIndex: number },
  ) => Promise<void>;
  // Send every text block of these rows that has no claim yet.
  deliverUnclaimed: (rows: Message[]) => Promise<void>;
}

export const createDelivery = (input: DeliveryInput): Delivery => {
  const deliver = async (
    text: string,
    ref?: { messageId: number | null; blockIndex: number },
  ): Promise<void> => {
    if (
      ref &&
      ref.messageId !== null &&
      !input.claim(ref.messageId, ref.blockIndex)
    ) {
      log("delivery_skipped", { block_index: ref.blockIndex });
      return;
    }
    await input.send(text);
    input.onSent?.(text);
  };

  const deliverUnclaimed = async (rows: Message[]): Promise<void> => {
    for (const row of rows) {
      if (row.role !== "assistant") continue;
      const blocks = toBlocks(row.content);
      // Claiming is what decides whether a block goes out; this only narrows the
      // candidates to text blocks that carry something to say.
      for (const blockIndex of unclaimedBlockIndexes(row.content, [])) {
        const block = blocks[blockIndex];
        if (block.type !== "text") continue;
        await deliver(block.text, { messageId: row.id, blockIndex });
      }
    }
  };

  return { deliver, deliverUnclaimed };
};
