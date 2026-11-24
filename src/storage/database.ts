import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { Settings } from "../config/settings";

const DB_PATH = Settings.DATABASE_PATH;
let dbInstance: Database.Database | null = null;

export function getConnection(): Database.Database {
    if (!dbInstance) {
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Ensure the database file exists before opening, with proper permissions
        if (!fs.existsSync(DB_PATH)) {
            fs.writeFileSync(DB_PATH, "", { mode: 0o600 });
        } else {
            // Verify the file is writable
            try {
                fs.accessSync(DB_PATH, fs.constants.R_OK | fs.constants.W_OK);
            } catch {
                throw new Error(
                    `Database file at "${DB_PATH}" is not writable. ` +
                    `Run: chown -R $(whoami) "${dir}" && chmod -R 755 "${dir}"`
                );
            }
        }

        dbInstance = new Database(DB_PATH);
        dbInstance.pragma("journal_mode = WAL");
        dbInstance.pragma("foreign_keys = ON");
        dbInstance.pragma("busy_timeout = 5000");
    }
    return dbInstance;
}

export function initDb(): void {
    const db = getConnection();
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            first_name TEXT,
            username TEXT,
            first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            message_count INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS chat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            prompt_revision INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_chat_history_user_id
            ON chat_history(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_chat_history_user_id_message
            ON chat_history(user_id, id);

        CREATE TABLE IF NOT EXISTS model_usage (
            id INTEGER PRIMARY KEY,
            chat_id TEXT,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            kind TEXT NOT NULL,
            input_tokens INTEGER,
            output_tokens INTEGER,
            total_tokens INTEGER,
            audio_seconds REAL,
            cost_usd REAL,
            cost_basis TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_model_usage_time ON model_usage(created_at);
        CREATE INDEX IF NOT EXISTS idx_model_usage_chat_time ON model_usage(chat_id, created_at);

        CREATE TABLE IF NOT EXISTS whatsapp_sessions (
            id TEXT PRIMARY KEY,
            session_data TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS whatsapp_handoffs (
            id INTEGER PRIMARY KEY,
            chat_id TEXT NOT NULL,
            source_message_id TEXT NOT NULL,
            recipient TEXT NOT NULL CHECK (recipient IN ('sales', 'engineer')),
            summary TEXT NOT NULL,
            summary_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
            whatsapp_message_id TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(chat_id, source_message_id, recipient)
        );
        CREATE INDEX IF NOT EXISTS idx_handoffs_chat ON whatsapp_handoffs(chat_id, id);
    `);
    db.transaction(() => {
        if (!db.prepare("SELECT 1 FROM pragma_table_info('chat_history') WHERE name = 'prompt_revision'").get()) {
            db.exec("ALTER TABLE chat_history ADD COLUMN prompt_revision INTEGER NOT NULL DEFAULT 0");
        }
    }).immediate();
    console.log(`Database initialized at ${DB_PATH}`);
}
