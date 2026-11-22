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
2. Choose Ollama, OpenRouter, or Gemini under **AI provider**. Enter the model ID and API key, save to activate, and test your connection. For a local Ollama server, set `OLLAMA_HOST` in `.env`.
3. Under **WhatsApp**, select **Connect WhatsApp**. On your phone, open WhatsApp and go to **Linked devices → Link a device**, then scan the QR code shown in the dashboard.
4. Once the status reads **Connected**, send a message from another WhatsApp account to try the bot.

The dashboard starts before you enter any API keys. Saved settings and WhatsApp sessions live in SQLite. holool-bot reconnects a saved WhatsApp session when it starts. The dashboard shows whether a provider key is saved. Leave its field blank to keep the saved key, or enter a replacement to rotate it.

Set `GROQ_API_KEY` in `.env` to enable the original voice transcription flow. To link an account from the terminal, run `npm run start:linked` with the dashboard stopped.

## Docker

Copy `.env.example` to `.env` and run `docker compose up --build -d`. Compose publishes the dashboard to host loopback on port 3000.
