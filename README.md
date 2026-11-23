# holool-bot

A WhatsApp bot with a local Holool dashboard for editing the system prompt, selecting an AI provider, and pairing a WhatsApp account through Baileys.

## Run locally

Use Node.js 22 or newer.

```sh
npm ci
npm run build
npm start
```

Open [Bot setup](http://127.0.0.1:3000).

1. Review the existing instructions under **System prompt**, or save your own.
2. Choose **OpenRouter Free** or **Groq Free plan** under **AI provider**, pick a cloud model from the dropdown, and save. Run **Test active provider** to generate a test reply.
3. Under **WhatsApp**, select **Connect WhatsApp**. On your phone, open WhatsApp and go to **Linked devices → Link a device**, then scan the QR code shown in the dashboard.
4. Once the status reads **Connected**, send a message from another WhatsApp account to try the bot.

The dashboard starts before you enter any API keys. Saved settings and WhatsApp sessions live in SQLite. holool-bot reconnects a saved WhatsApp session when it starts. The dashboard shows whether a provider key is saved. Leave its field blank to keep the saved key, or enter a replacement to rotate it.

- **OpenRouter Free** loads the current selection of free chat models. Its **Automatic** option picks an available free model. Enter an [OpenRouter API key](https://openrouter.ai/settings/keys).
- **Groq Free plan** offers Qwen 3.8 27B, GPT-OSS 20B, and GPT-OSS 120B. Confirm your organization's plan in [Groq Billing](https://console.groq.com/settings/billing). If `GROQ_API_KEY` is already configured, the dashboard can reuse it. You can use a separate `GROQ_CHAT_API_KEY` for chat.

Set `GROQ_API_KEY` in `.env` to enable voice transcription. To link an account from the terminal, run `npm run start:linked` with the dashboard stopped.

## Docker

Copy `.env.example` to `.env` and run `docker compose up --build -d`. Compose publishes the dashboard to host loopback on port 3000.
