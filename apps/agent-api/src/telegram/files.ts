// Download a Telegram file's bytes. Two steps per the Bot API: getFile resolves
// a file_id to a temporary file_path, then the bytes are fetched from
// {apiRoot}/file/bot{token}/{file_path}. The token is in the URL only; it never
// leaves the Worker. Returns the file_path too so the caller can borrow a real
// extension for a synthesized filename (see refineFilename).

import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Env } from "../types";

export interface DownloadedFile {
  bytes: Uint8Array;
  filePath: string;
}

export const downloadTelegramFile = async (
  env: Env,
  fileId: string,
): Promise<DownloadedFile> => {
  const botInfo = JSON.parse(env.TELEGRAM_BOT_INFO) as UserFromGetMe;
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, {
    botInfo,
    client: { apiRoot: env.TELEGRAM_API_ROOT },
  });
  const file = await bot.api.getFile(fileId);
  const filePath = file.file_path ?? "";
  const url = `${env.TELEGRAM_API_ROOT}/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`telegram file download failed: ${res.status}`);
  }
  return { bytes: new Uint8Array(await res.arrayBuffer()), filePath };
};
