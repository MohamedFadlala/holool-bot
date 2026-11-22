import { initAuthCreds, BufferJSON, AuthenticationState, SignalDataTypeMap } from "@whiskeysockets/baileys";
import { getConnection } from "../storage/database";


function readData(id: string) {
    const row = getConnection().prepare("SELECT session_data FROM whatsapp_sessions WHERE id = ?")
        .get(id) as { session_data: string } | undefined;
    return row ? JSON.parse(row.session_data, BufferJSON.reviver) : null;
}

export function hasLinkedDevice(sessionId: string) {
    return Boolean(readData(`${sessionId}:creds`)?.me?.id);
}

export function clearAuthState(sessionId: string) {
    const prefix = sessionId + ":";
    getConnection().prepare("DELETE FROM whatsapp_sessions WHERE substr(id, 1, ?) = ?")
        .run(prefix.length, prefix);
}

export const useSqliteAuthState = async (sessionId: string): Promise<{ state: AuthenticationState, saveCreds: () => void; getWriteErrorCount: () => number }> => {
    const db = getConnection();

    let writeErrorCount = 0;

    const writeData = (id: string, data: any) => {
        const str = JSON.stringify(data, BufferJSON.replacer);
        db.prepare(`
            INSERT INTO whatsapp_sessions (id, session_data) 
            VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET 
                session_data = excluded.session_data,
                updated_at = CURRENT_TIMESTAMP
        `).run(id, str);
        // If we get here, the write succeeded — reset error counter
        writeErrorCount = 0;
    };

    const removeData = (id: string) => {
        try {
            db.prepare("DELETE FROM whatsapp_sessions WHERE id = ?").run(id);
        } catch (e) {
            console.error("Error removing auth state", e);
        }
    };

    const credsKey = `${sessionId}:creds`;
    
    let creds = readData(credsKey);
    if (!creds) {
        creds = initAuthCreds();
        writeData(credsKey, creds);
    }

    return {
        state: {
            creds,
            keys: {
                get: (type: keyof SignalDataTypeMap, ids: string[]) => {
                    const data: { [id: string]: any } = {};
                    for (const id of ids) {
                        const key = `${sessionId}:${type}:${id}`;
                        const val = readData(key);
                        if (val) {
                            data[id] = val;
                        }
                    }
                    return data;
                },
                set: (data: any) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const val = data[category][id];
                            const key = `${sessionId}:${category}:${id}`;
                            if (val) {
                                writeData(key, val);
                            } else {
                                removeData(key);
                            }
                        }
                    }
                }
            }
        },
        saveCreds: () => {
            try {
                writeData(credsKey, creds);
            } catch (e: any) {
                writeErrorCount++;
                console.error("Error writing auth state", e);
                // Re-throw so the session manager can detect the failure
                throw e;
            }
        },
        getWriteErrorCount: () => writeErrorCount,
    };
};
