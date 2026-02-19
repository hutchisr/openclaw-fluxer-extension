import { Client, GatewayDispatchEvents } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import { sendMessage, triggerTyping } from "./rest.js";

const FLUXER_API = "https://api.fluxer.app";
const FLUXER_VERSION = "1";

export type FluxerMonitorOpts = {
  token: string;
  accountId?: string;
  config: any;
  runtime: any;
  core: any;
  abortSignal?: AbortSignal;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
};

export async function monitorFluxerProvider(opts: FluxerMonitorOpts): Promise<void> {
  const { token, accountId = "default", config: cfg, runtime, core, abortSignal, log } = opts;

  const rest = new REST({ api: FLUXER_API, version: FLUXER_VERSION }).setToken(token);
  const gateway = new WebSocketManager({
    token,
    intents: 0,
    rest,
    version: FLUXER_VERSION,
    initialPresence: {
      status: "online" as any,
      activities: [],
      since: null,
      afk: false,
    },
  });
  const client = new Client({ rest, gateway });

  let selfUserId: string | null = null;
  const startupMs = Date.now();
  const startupGraceMs = 10_000;

  // Build allowlist for DM access
  const fluxerConfig = cfg?.channels?.fluxer ?? {};
  const dmPolicy = fluxerConfig.dm?.policy ?? "pairing";
  const configAllowFrom: string[] = (fluxerConfig.dm?.allowFrom ?? []).map(String);

  // Read store allowlist (may not be available on all runtime versions)
  let storeAllowFrom: string[] = [];
  try {
    if (core?.channel?.pairing?.readAllowFromStore) {
      storeAllowFrom = await core.channel.pairing.readAllowFromStore("fluxer");
    }
  } catch {
    // Ignore — store may not exist yet
  }
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];

  function isAllowed(senderId: string): boolean {
    return effectiveAllowFrom.some(
      (entry) => entry === senderId || entry === "*",
    );
  }

  // Handle abort
  if (abortSignal) {
    abortSignal.addEventListener(
      "abort",
      () => {
        log?.info("fluxer: abort signal received, destroying gateway");
        gateway.destroy().catch(() => {});
      },
      { once: true },
    );
  }

  client.on(GatewayDispatchEvents.Ready, ({ data }) => {
    selfUserId = data.user.id;
    log?.info(
      `fluxer: logged in as ${data.user.username}#${data.user.discriminator ?? "0000"}`,
    );
  });

  client.on(GatewayDispatchEvents.MessageCreate, async ({ data }) => {
    try {
      const msg = data as {
        id: string;
        channel_id: string;
        content: string;
        author: { id: string; username: string; bot?: boolean; discriminator?: string };
        guild_id?: string;
        timestamp?: string;
        referenced_message?: { id: string };
        attachments?: Array<{ url: string; content_type?: string; filename?: string }>;
      };

      // Ignore own messages and bot messages
      if (msg.author.id === selfUserId) return;
      if (msg.author.bot) return;

      // Ignore old messages from before startup
      const eventTs = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
      if (eventTs < startupMs - startupGraceMs) return;

      const isDm = !msg.guild_id;
      const channelId = msg.channel_id;
      const senderId = msg.author.id;
      const senderName = msg.author.username;
      const bodyText = msg.content?.trim() || "";

      if (!bodyText && (!msg.attachments || msg.attachments.length === 0)) return;

      // DM policy enforcement
      if (isDm) {
        if (dmPolicy === "disabled") return;

        if (dmPolicy !== "open" && !isAllowed(senderId)) {
          if (dmPolicy === "pairing") {
            try {
              if (core?.channel?.pairing?.upsertPairingRequest) {
                const { code, created } = await core.channel.pairing.upsertPairingRequest({
                  channel: "fluxer",
                  id: senderId,
                  meta: { name: senderName },
                });
                if (created) {
                  await sendMessage(channelId, [
                    "🦐 OpenClaw: access not configured.",
                    "",
                    `Pairing code: \`${code}\``,
                    "",
                    "Ask the bot owner to approve:",
                    "`openclaw pairing approve fluxer <code>`",
                  ].join("\n"));
                }
              }
            } catch (err) {
              log?.warn(`fluxer: pairing reply failed: ${String(err)}`);
            }
          }
          return;
        }
      }

      // Group messages: check mention requirement
      if (!isDm) {
        const groupPolicy = fluxerConfig.groupPolicy ?? "open";
        if (groupPolicy === "disabled") return;

        // Require @mention in groups by default
        const selfMentionPattern = selfUserId ? new RegExp(`<@!?${selfUserId}>`) : null;
        const hasSelfMention = selfMentionPattern ? selfMentionPattern.test(bodyText) : false;

        // Also check configured mention patterns if available
        let hasConfigMention = false;
        try {
          if (core?.channel?.mentions?.buildMentionRegexes) {
            const regexes = core.channel.mentions.buildMentionRegexes(cfg);
            hasConfigMention = core.channel.mentions.matchesMentionPatterns(bodyText, regexes);
          }
        } catch {}

        if (!hasSelfMention && !hasConfigMention) {
          return; // Skip non-mentioned group messages
        }
      }

      // Download first attachment as media if present
      let mediaPath: string | undefined;
      if (msg.attachments && msg.attachments.length > 0) {
        const att = msg.attachments[0]!;
        try {
          if (core?.channel?.media?.fetchRemoteMedia && core?.channel?.media?.saveMediaBuffer) {
            const fetched = await core.channel.media.fetchRemoteMedia({ url: att.url });
            const saved = await core.channel.media.saveMediaBuffer(
              fetched.buffer,
              fetched.contentType ?? att.content_type,
              "inbound",
              (fluxerConfig.mediaMaxMb ?? 25) * 1024 * 1024,
            );
            mediaPath = saved.path;
          }
        } catch (err) {
          log?.warn(`fluxer: media download failed: ${String(err)}`);
        }
      }

      // Resolve session routing
      let sessionKey: string;
      let agentRoute: any;

      try {
        if (core?.channel?.routing?.resolveAgentRoute) {
          agentRoute = core.channel.routing.resolveAgentRoute({
            cfg,
            channel: "fluxer",
            accountId,
            peer: {
              kind: isDm ? "direct" : "channel",
              id: isDm ? senderId : channelId,
            },
          });
          sessionKey = agentRoute.sessionKey;
        } else {
          // Fallback: construct session key manually
          sessionKey = isDm
            ? "agent:main:main"
            : `agent:main:fluxer:channel:${channelId}`;
        }
      } catch {
        sessionKey = isDm ? "agent:main:main" : `agent:main:fluxer:channel:${channelId}`;
      }

      // Strip self-mention from body for cleaner agent input
      let cleanBody = bodyText;
      if (selfUserId) {
        cleanBody = bodyText.replace(new RegExp(`<@!?${selfUserId}>\\s*`, "g"), "").trim();
      }

      // Format the inbound message envelope
      const fromLabel = isDm ? senderName : `#${channelId}`;
      const messageId = msg.id;

      // Start typing indicator (re-trigger every 8s since it lasts ~10s)
      let typingActive = true;
      const sendTyping = () => {
        triggerTyping(channelId).catch(() => {});
      };
      sendTyping();
      const typingInterval = setInterval(() => {
        if (typingActive) sendTyping();
      }, 5000);
      const stopTyping = () => {
        typingActive = false;
        clearInterval(typingInterval);
      };

      // Build the inbound context payload
      const envelopeOptions = core?.channel?.reply?.resolveEnvelopeFormatOptions?.(cfg) ?? {};
      const formattedBody = core?.channel?.reply?.formatAgentEnvelope?.({
        channel: "Fluxer",
        from: fromLabel,
        timestamp: eventTs,
        envelope: envelopeOptions,
        body: cleanBody,
      }) ?? `[Fluxer message from ${fromLabel}]\n${cleanBody}`;

      const ctxPayload: Record<string, unknown> = {
        Body: formattedBody,
        BodyForAgent: cleanBody,
        RawBody: bodyText,
        CommandBody: cleanBody,
        From: isDm ? `fluxer:${senderId}` : `fluxer:channel:${channelId}`,
        To: channelId,
        SessionKey: sessionKey,
        AccountId: agentRoute?.accountId ?? accountId,
        ChatType: isDm ? "direct" : "channel",
        ConversationLabel: fromLabel,
        SenderName: senderName,
        SenderId: senderId,
        SenderUsername: msg.author.username,
        GroupSubject: isDm ? undefined : channelId,
        Provider: "fluxer",
        Surface: "fluxer",
        WasMentioned: !isDm ? true : undefined,
        MessageSid: messageId,
        ReplyToId: msg.referenced_message?.id,
        Timestamp: eventTs,
        MediaPath: mediaPath,
        MediaUrl: mediaPath,
        OriginatingChannel: "fluxer",
        OriginatingTo: channelId,
      };

      // Try the full buffered dispatch pipeline
      const replyToMode = fluxerConfig.replyToMode ?? "off";
      try {
        if (core?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
          await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              deliver: async (payload: { text?: string; mediaUrl?: string; audioAsVoice?: boolean }) => {
                const replyToId = replyToMode !== "off" ? messageId : undefined;
                await sendMessage(channelId, payload.text ?? "", {
                  replyTo: replyToId,
                  mediaUrl: payload.mediaUrl,
                });
              },
              onError: (err: unknown, info: { kind: string }) => {
                log?.warn(`fluxer: ${info.kind} reply failed: ${String(err)}`);
              },
            },
          });
          stopTyping();
          log?.info(`fluxer: dispatched reply to ${channelId}`);

          // Emit system event for main session visibility
          if (!isDm && core?.system?.enqueueSystemEvent) {
            core.system.enqueueSystemEvent(
              `Fluxer message from ${senderName}: ${cleanBody.slice(0, 160)}`,
              { sessionKey },
            );
          }
          return;
        }
      } catch (err) {
        log?.warn(`fluxer: buffered dispatch failed: ${String(err)}`);
      }

      // Fallback: try dispatchReplyFromConfig with proper dispatcher if available
      try {
        if (core?.channel?.reply?.dispatchInboundMessageWithBufferedDispatcher) {
          await core.channel.reply.dispatchInboundMessageWithBufferedDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              deliver: async (payload: { text?: string; mediaUrl?: string }) => {
                const replyToId = replyToMode !== "off" ? messageId : undefined;
                await sendMessage(channelId, payload.text ?? "", {
                  replyTo: replyToId,
                  mediaUrl: payload.mediaUrl,
                });
              },
              onError: (err: unknown, info: { kind: string }) => {
                log?.warn(`fluxer: ${info.kind} reply failed: ${String(err)}`);
              },
            },
          });
          stopTyping();
          log?.info(`fluxer: dispatched reply (fallback) to ${channelId}`);
          return;
        }
      } catch (err) {
        log?.warn(`fluxer: fallback dispatch failed: ${String(err)}`);
      }

      // Last resort: system event injection
      try {
        if (core?.system?.enqueueSystemEvent) {
          core.system.enqueueSystemEvent(
            `Fluxer message from ${senderName}: ${cleanBody.slice(0, 500)}`,
            { sessionKey },
          );
          log?.info(`fluxer: injected system event for ${channelId}`);
        } else {
          log?.warn(`fluxer: no dispatch mechanism available for message from ${senderName}`);
        }
      } catch (err) {
        log?.warn(`fluxer: last resort dispatch failed: ${String(err)}`);
      } finally {
        stopTyping();
      }
    } catch (err) {
      stopTyping();
      log?.warn?.(`fluxer: handler error: ${String(err)}`);
      runtime?.error?.(`fluxer handler failed: ${String(err)}`);
    }
  });

  await gateway.connect();

  // Keep alive until abort
  if (abortSignal) {
    await new Promise<void>((resolve) => {
      if (abortSignal.aborted) {
        resolve();
        return;
      }
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}
