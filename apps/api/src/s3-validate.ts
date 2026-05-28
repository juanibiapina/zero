// Lightweight S3 bucket validation using aws4fetch (SigV4 signing for Workers).
//
// Performs a ListObjectsV2?max-keys=0 call against the user's S3 endpoint.
// This validates: endpoint reachability, bucket existence, credential validity,
// and prefix accessibility — all in one request with zero data transfer.

import { AwsClient } from "aws4fetch";
import type { S3MountConfig } from "./UserDO/index";

export interface ValidateResult {
  ok: boolean;
  error?: string;
}

export const validateS3Bucket = async (
  config: S3MountConfig,
): Promise<ValidateResult> => {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
  });

  const url = new URL(`/${config.bucket}`, config.endpoint);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("max-keys", "0");
  if (config.prefix) {
    url.searchParams.set("prefix", config.prefix);
  }

  let res: Response;
  try {
    res = await client.fetch(url.toString(), { method: "GET" });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "connection failed";
    return { ok: false, error: message };
  }

  if (res.ok) return { ok: true };

  // Try to extract an S3 error message from the XML response
  const body = await res.text().catch(() => "");
  const codeMatch = body.match(/<Code>(.*?)<\/Code>/);
  const msgMatch = body.match(/<Message>(.*?)<\/Message>/);
  const detail = msgMatch?.[1] ?? codeMatch?.[1] ?? `HTTP ${res.status}`;
  return { ok: false, error: detail };
};
