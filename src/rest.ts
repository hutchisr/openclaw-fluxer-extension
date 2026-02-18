import { REST } from "@discordjs/rest";

const FLUXER_API = "https://api.fluxer.app";
const FLUXER_VERSION = "1";

let restClient: REST | null = null;

export function initRest(token: string): REST {
  restClient = new REST({ api: FLUXER_API, version: FLUXER_VERSION }).setToken(token);
  return restClient;
}

export function getRest(): REST {
  if (!restClient) {
    throw new Error("Fluxer REST client not initialized");
  }
  return restClient;
}

/**
 * Open (or retrieve) a DM channel with a user, then send there.
 */
async function openDmChannel(userId: string): Promise<string> {
  const rest = getRest();
  const result = (await rest.post("/users/@me/channels", {
    body: { recipient_id: userId },
  })) as { id: string };
  return result.id;
}

/**
 * Send a text message (and optionally media) to a Fluxer channel.
 */
export async function sendMessage(
  target: string,
  text: string,
  opts?: {
    replyTo?: string;
    mediaUrl?: string;
  },
): Promise<{ messageId?: string; channelId?: string }> {
  const rest = getRest();

  // If target looks like "user:<id>", open a DM channel first
  let channelId = target;
  if (target.startsWith("user:")) {
    const userId = target.slice("user:".length);
    channelId = await openDmChannel(userId);
  }

  const body: Record<string, unknown> = {};
  if (text) {
    body.content = text;
  }
  if (opts?.replyTo) {
    body.message_reference = { message_id: opts.replyTo };
  }

  // If mediaUrl is provided, download and attach as multipart form
  if (opts?.mediaUrl) {
    const fs = await import("node:fs");
    const path = await import("node:path");

    let fileBuffer: Buffer;
    let filename: string;
    let contentType: string | undefined;

    if (opts.mediaUrl.startsWith("http://") || opts.mediaUrl.startsWith("https://")) {
      const response = await fetch(opts.mediaUrl);
      fileBuffer = Buffer.from(await response.arrayBuffer());
      contentType = response.headers.get("content-type") ?? undefined;
      const urlPath = new URL(opts.mediaUrl).pathname;
      filename = path.basename(urlPath) || "file";
    } else {
      // Local file path
      fileBuffer = fs.readFileSync(opts.mediaUrl);
      filename = path.basename(opts.mediaUrl);
    }

    // Use @discordjs/rest file upload format
    const result = (await rest.post(`/channels/${channelId}/messages`, {
      body,
      files: [
        {
          name: filename,
          data: fileBuffer,
          contentType: contentType ?? "application/octet-stream",
        },
      ],
    })) as { id?: string; channel_id?: string };

    return { messageId: result?.id, channelId: result?.channel_id };
  }

  // Simple text message
  const result = (await rest.post(`/channels/${channelId}/messages`, {
    body,
  })) as { id?: string; channel_id?: string };

  return { messageId: result?.id, channelId: result?.channel_id };
}

/**
 * Trigger the typing indicator in a channel.
 * Typing status lasts ~10 seconds or until a message is sent.
 */
export async function triggerTyping(channelId: string): Promise<void> {
  const rest = getRest();
  await rest.post(`/channels/${channelId}/typing`, { body: {} });
}

/**
 * Probe the bot by fetching /users/@me
 */
export async function probeBot(
  token: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; error?: string; bot?: { id: string; username: string } }> {
  const probe = new REST({ api: FLUXER_API, version: FLUXER_VERSION }).setToken(token);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const user = (await probe.get("/users/@me", {
      signal: controller.signal as AbortSignal,
    })) as { id: string; username: string; discriminator?: string };
    clearTimeout(timer);
    return {
      ok: true,
      bot: { id: user.id, username: user.username },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetch a specific channel by ID
 */
export async function fetchChannel(
  channelId: string,
): Promise<{ id: string; name?: string; type: number; guild_id?: string } | null> {
  try {
    const rest = getRest();
    const ch = (await rest.get(`/channels/${channelId}`)) as {
      id: string;
      name?: string;
      type: number;
      guild_id?: string;
    };
    return ch;
  } catch {
    return null;
  }
}
