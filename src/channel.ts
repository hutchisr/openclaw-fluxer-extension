import {
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { getFluxerApi } from "./runtime.js";
import { sendMessage, probeBot, initRest } from "./rest.js";
import { monitorFluxerProvider } from "./gateway.js";

type FluxerAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  token?: string;
  tokenSource?: string;
  config: Record<string, unknown>;
};

function resolveFluxerAccount(cfg: any, accountId?: string | null): FluxerAccount {
  const fluxerConfig = cfg?.channels?.fluxer ?? {};
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  return {
    accountId: id,
    name: fluxerConfig.name,
    enabled: fluxerConfig.enabled !== false,
    token: fluxerConfig.token || process.env.FLUXER_BOT_TOKEN,
    tokenSource: fluxerConfig.token
      ? "config"
      : process.env.FLUXER_BOT_TOKEN
        ? "env:FLUXER_BOT_TOKEN"
        : "none",
    config: fluxerConfig,
  };
}

export const fluxerPlugin: ChannelPlugin<FluxerAccount> = {
  id: "fluxer",
  meta: {
    id: "fluxer",
    label: "Fluxer",
    selectionLabel: "Fluxer",
    docsPath: "/channels/fluxer",
    docsLabel: "fluxer",
    blurb: "Discord-compatible chat; configure a bot token.",
    order: 80,
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "fluxerUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(fluxer|user):/i, ""),
    notifyApproval: async ({ id }) => {
      await sendMessage(`user:${id}`, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel"],
    media: true,
    reactions: false,
    polls: false,
    threads: false,
  },
  reload: { configPrefixes: ["channels.fluxer"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) => resolveFluxerAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg }) =>
      (cfg?.channels?.fluxer?.dm?.allowFrom ?? []).map((e: unknown) => String(e)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((e) => String(e).trim().toLowerCase()).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: (account.config as any).dm?.policy ?? "pairing",
      allowFrom: (account.config as any).dm?.allowFrom ?? [],
      allowFromPath: "channels.fluxer.dm.allowFrom",
      approveHint: formatPairingApproveHint("fluxer"),
      normalizeEntry: (raw) => raw.replace(/^(fluxer|user):/i, ""),
    }),
  },
  messaging: {
    normalizeTarget: (raw) => {
      let normalized = raw.trim();
      if (normalized.startsWith("fluxer:")) {
        normalized = normalized.slice("fluxer:".length).trim();
      }
      return normalized.replace(/^(channel|user):/i, "").trim() || undefined;
    },
    targetResolver: {
      looksLikeId: (raw) => /^\d{17,20}$/.test(raw.replace(/^(fluxer:|channel:|user:)/i, "").trim()),
      hint: "<channelId|user:ID>",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    validateInput: ({ input }) => {
      if (!input.useEnv && !input.token) {
        return "Fluxer requires a token (or --use-env for FLUXER_BOT_TOKEN).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        fluxer: {
          ...(cfg as any).channels?.fluxer,
          enabled: true,
          ...(input.useEnv ? {} : input.token ? { token: input.token } : {}),
        },
      },
    }),
  },
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 2000,
    sendText: async ({ to, text, replyToId }) => {
      const result = await sendMessage(to, text, { replyTo: replyToId ?? undefined });
      return { channel: "fluxer", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, replyToId }) => {
      const result = await sendMessage(to, text, {
        replyTo: replyToId ?? undefined,
        mediaUrl,
      });
      return { channel: "fluxer", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "fluxer",
            accountId: account.accountId,
            kind: "runtime" as const,
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    probeAccount: async ({ account, timeoutMs }) => {
      const token = account.token?.trim();
      if (!token) return { ok: false, error: "no token" };
      return probeBot(token, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      bot: (probe as any)?.bot,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token?.trim();
      if (!token) {
        throw new Error("Fluxer bot token is required");
      }

      // Initialize the REST client for outbound
      initRest(token);

      // Probe bot
      let botLabel = "";
      try {
        const probe = await probeBot(token, 3000);
        if (probe.ok && probe.bot) {
          botLabel = ` (@${probe.bot.username})`;
          ctx.setStatus({ accountId: account.accountId, bot: probe.bot });
        }
      } catch {}

      ctx.log?.info(`[${account.accountId}] starting Fluxer provider${botLabel}`);

      const api = getFluxerApi();
      return monitorFluxerProvider({
        token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        core: api.runtime,
        abortSignal: ctx.abortSignal,
        log: ctx.log,
      });
    },
  },
};
