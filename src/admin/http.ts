import { IncomingMessage } from "node:http";

export class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

export async function readBody(req: IncomingMessage) {
    const limit = 1024 * 1024;
    if (Number(req.headers["content-length"]) > limit) throw new HttpError(413, "Request is too large.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > limit) throw new HttpError(413, "Request is too large.");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
