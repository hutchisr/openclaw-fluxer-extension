# openclaw-fluxer

An [OpenClaw](https://github.com/openclaw/openclaw) channel plugin for [Fluxer](https://fluxer.app), a Discord-compatible instant messaging platform.

## Features

- DM and channel message support
- Typing indicators
- Media attachments (send & receive)
- Pairing-based access control
- Reply-to threading

## Setup

### 1. Install

Clone this repo into your OpenClaw extensions directory:

```bash
git clone https://github.com/YOUR_USER/openclaw-fluxer ~/.openclaw/extensions/fluxer
cd ~/.openclaw/extensions/fluxer
npm install
```

### 2. Create a Fluxer bot

1. Open the Fluxer app and sign in
2. Go to **User Settings → Applications**
3. Create an application
4. Copy the **Bot token**
5. In the **OAuth2 URL Builder**, select **Bot**, copy the authorize URL, and invite the bot to your community

### 3. Configure OpenClaw

Add to your `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    fluxer: {
      enabled: true,
      token: "YOUR_BOT_TOKEN"
    }
  },
  plugins: {
    entries: {
      fluxer: {
        enabled: true
      }
    }
  }
}
```

Or set the token via environment variable:

```bash
export FLUXER_BOT_TOKEN="your_bot_token_here"
```

### 4. Restart the gateway

```bash
openclaw gateway restart
```

### 5. Pair your account

DM the bot on Fluxer — it will give you a pairing code. Approve it:

```bash
openclaw pairing approve fluxer <code>
```

## Configuration

```json5
{
  channels: {
    fluxer: {
      enabled: true,
      token: "...",
      dm: {
        policy: "pairing",    // pairing | allowlist | open | disabled
        allowFrom: []          // user IDs for allowlist mode
      },
      groupPolicy: "open",    // open | disabled
      replyToMode: "off",     // off | on (reply threading)
      mediaMaxMb: 25
    }
  }
}
```

## How it works

This plugin uses the `@discordjs/core`, `@discordjs/rest`, and `@discordjs/ws` packages pointed at Fluxer's API (`https://api.fluxer.app`). Fluxer's API is intentionally Discord-compatible, so these packages work with minimal configuration.

The plugin registers as an OpenClaw channel and handles:
- **Inbound**: WebSocket gateway connection, message parsing, DM policy enforcement, mention gating for groups
- **Outbound**: REST API message sending with text and media support
- **Typing**: Typing indicators while generating responses

## Requirements

- OpenClaw 2026.2.x or later
- Node.js 22+
- A Fluxer account and bot application

## License

MIT
