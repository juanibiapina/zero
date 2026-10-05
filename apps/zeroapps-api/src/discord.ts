// Posts plain-text messages to a Discord channel via an incoming webhook URL.
//
// A failed notification must never fail the caller: non-2xx responses and
// network errors are logged and swallowed.

export const notifyDiscord = async (
  webhookUrl: string,
  content: string,
): Promise<void> => {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      console.error("discord_notify_failed", { status: res.status });
    }
  } catch (err) {
    console.error("discord_notify_failed", { error: String(err) });
  }
};
