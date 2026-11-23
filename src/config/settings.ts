import * as path from "path";
import * as dotenv from "dotenv";

// Load .env from project root
const PROJECT_ROOT = path.resolve(__dirname, "../../");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

export class Settings {
    // --- AI Provider ---
    static AI_PROVIDER = process.env.AI_PROVIDER || "openrouter";

    // Ollama
    static OLLAMA_HOST = process.env.OLLAMA_HOST || "https://ollama.com";
    static OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
    static OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:31b-cloud";

    // OpenRouter
    static OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
    static OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";

    // Groq chat and voice transcription
    static GROQ_API_KEY = process.env.GROQ_API_KEY || "";
    static GROQ_CHAT_API_KEY = process.env.GROQ_CHAT_API_KEY || Settings.GROQ_API_KEY;
    static GROQ_CHAT_MODEL = process.env.GROQ_CHAT_MODEL || "qwen/qwen3.8-27b";
    static GROQ_FREE_PLAN_CONFIRMED = process.env.GROQ_FREE_PLAN_CONFIRMED === "true";
    static GROQ_MODEL = process.env.GROQ_MODEL || "whisper-large-v3-turbo";

    static get groqVoiceKey() {
        return this.GROQ_API_KEY || (this.GROQ_FREE_PLAN_CONFIRMED ? this.GROQ_CHAT_API_KEY : "");
    }

    // Gemini
    static GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
    static GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
    static GEMINI_FREE_PLAN_CONFIRMED = process.env.GEMINI_FREE_PLAN_CONFIRMED === "true";

    // --- Bot Behavior ---
    static DEBOUNCE_SECONDS = parseFloat(process.env.DEBOUNCE_SECONDS || "3.0");
    static MAX_HISTORY_MESSAGES = parseInt(process.env.MAX_HISTORY_MESSAGES || "20", 10);

    // --- Paths ---
    static DATABASE_PATH = process.env.DATABASE_PATH || "data/whatsapp.db";
    static LOG_LEVEL = process.env.LOG_LEVEL || "INFO";
    static LOG_FILE = process.env.LOG_FILE || "logs/bot.log";

    static validate() {
        const errors: string[] = [];

        if (this.AI_PROVIDER === "ollama" && this.OLLAMA_HOST === "https://ollama.com" && !this.OLLAMA_API_KEY) {
            errors.push("OLLAMA_API_KEY is required when AI_PROVIDER=ollama");
        }
        if (this.AI_PROVIDER === "openrouter" && !this.OPENROUTER_API_KEY) {
            errors.push("OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter");
        }
        if (this.AI_PROVIDER === "groq" && (!this.GROQ_CHAT_API_KEY || !this.GROQ_FREE_PLAN_CONFIRMED)) {
            errors.push("Groq requires an API key from a Free-plan organization.");
        }
        if (this.AI_PROVIDER === "gemini" && (!this.GEMINI_API_KEY || !this.GEMINI_FREE_PLAN_CONFIRMED)) {
            errors.push("Gemini requires an API key from a Free-tier project.");
        }
        if (errors.length > 0) {
            throw new Error("Configuration errors:\n  - " + errors.join("\n  - "));
        }
    }
}
