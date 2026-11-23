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
2. Choose a provider under **AI provider**, follow its connection steps below, and select a cloud model. Run **Test active provider** to generate a test reply.
3. Under **WhatsApp**, select **Connect WhatsApp**. On your phone, open WhatsApp and go to **Linked devices → Link a device**, then scan the QR code shown in the dashboard.
4. Once the status reads **Connected**, send a message from another WhatsApp account to try the bot.

Use **Disconnect WhatsApp** to forget the saved device session. Reconnecting requires a new QR scan.

The **Active chat model** shows what the running bot will use for new replies. Use **Preview saved prompt** to try the saved instructions with that model without sending a WhatsApp message. When the system prompt changes, new replies use the customer's prior messages and assistant replies generated under the new prompt. The Chats dashboard keeps the full stored transcript.

The dashboard starts before you enter any API keys. Saved settings and WhatsApp sessions live in SQLite. holool-bot reconnects a saved WhatsApp session when it starts. The dashboard shows whether a provider key is saved. Leave its field blank to keep the saved key, or enter a replacement to rotate it.

- **OpenRouter Free** loads the current selection of free chat models. Its **Automatic** option picks an available free model. Enter an [OpenRouter API key](https://openrouter.ai/settings/keys).
- **Groq Free plan** offers Qwen 3.8 27B, GPT-OSS 20B, and GPT-OSS 120B. Confirm your organization's plan in [Groq Billing](https://console.groq.com/settings/billing). If `GROQ_API_KEY` is already configured, the dashboard can reuse it. You can use a separate `GROQ_CHAT_API_KEY` for chat.

- **Gemini Free tier** offers Gemini 3.5 Flash-Lite and 3.1 Flash-Lite. Use an API key from a [Google AI Studio](https://aistudio.google.com/api-keys) project on the Free tier.

- **OpenAI · ChatGPT plan** uses the Codex device-code flow and ChatGPT Responses transport described in [OpenClaw’s OpenAI authentication guide](https://docs.openclaw.ai/providers/openai/authentication). Select **Connect ChatGPT**, enter the one-time code on the OpenAI sign-in page, then choose a model from your account’s catalog and select **Save and activate**. Use **Refresh models** to update the catalog. The linked account’s ChatGPT/Codex allowance covers these requests. Sign-in stays on OpenAI’s page, and the bot keeps its OAuth session on the server. The usage dashboard records tokens and identifies these calls as ChatGPT plan usage. If OpenAI asks you to enable device-code authorization, turn it on in your ChatGPT security settings before retrying.

Voice notes use Groq Whisper Large v3 Turbo with any chat provider. holool-bot can reuse the saved Free-plan Groq key. Use **Save Groq key for voice** to configure that key while keeping Gemini or OpenRouter active. A dedicated `GROQ_API_KEY` in the environment takes precedence. To link an account from the terminal, run `npm run start:linked` with the dashboard stopped.

## Docker

Copy `.env.example` to `.env` and run `docker compose up --build -d`. Compose publishes the dashboard to host loopback on port 3000.

## Chats and API usage

Open **Chats & usage** to view stored WhatsApp conversations and filter recorded API usage by date. The dashboard reads input, output, and total tokens from provider responses. Expand a conversation to see its model usage and transcript. Groq Whisper is measured in audio seconds.

OpenRouter's reported costs take precedence. Confirmed Free plans are recorded at $0.00. When a separate Groq voice key is used, Whisper estimates use Groq's published hourly rate and ten-second minimum. Unknown costs stay unpriced, and the dashboard does not reconstruct token usage for requests made before tracking was added. Provider tests are counted outside chats.

## Production

GitHub Actions builds pull requests and deploys verified commits from `main` to [bot.holoolsoftware.com](https://bot.holoolsoftware.com). Nginx terminates TLS and authenticates the dashboard. The Node process listens on server loopback and accepts the public HTTPS origin through `HOLOOL_PUBLIC_ORIGIN`. The deploy script switches releases after a build and restores the previous version if the service fails its health check.
