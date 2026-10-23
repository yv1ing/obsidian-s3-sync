import type { RemoteSide } from "./types";

export const EMPTY_SHA256 =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const MTIME_TOLERANCE_MS = 2000;

const EPOCH_MS_THRESHOLD = 1e11;
const textEncoder = new TextEncoder();

const MIME_TYPES: Record<string, string> = {
    md: "text/markdown; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    json: "application/json; charset=utf-8",
    canvas: "application/json; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    yaml: "text/yaml; charset=utf-8",
    yml: "text/yaml; charset=utf-8",
    toml: "text/plain; charset=utf-8",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
    heic: "image/heic",
    heif: "image/heif",
    bmp: "image/bmp",
    ico: "image/x-icon",
    pdf: "application/pdf",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    flac: "audio/flac",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
    "7z": "application/x-7z-compressed",
};

export function toHex(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return Array.from(bytes, (byte) => (byte < 16 ? "0" : "") + byte.toString(16)).join("");
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
    const input = typeof data === "string"
        ? encodeUtf8(data)
        : data instanceof Uint8Array
            ? toArrayBuffer(data)
            : data;
    return toHex(await crypto.subtle.digest("SHA-256", input));
}

export async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
    const imported = await crypto.subtle.importKey(
        "raw",
        toArrayBuffer(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign(
        "HMAC",
        imported,
        encodeUtf8(data),
    ));
}

export function amzDate(date: Date = new Date()): string {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export function rfc3986(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

export function encodeKey(key: string): string {
    return key.split("/").map(rfc3986).join("/");
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function encodeUtf8(text: string): ArrayBuffer {
    return toArrayBuffer(textEncoder.encode(text));
}

export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function toEpochMs(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.round(value < EPOCH_MS_THRESHOLD ? value * 1000 : value);
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
            const numeric = Number(trimmed);
            return Number.isFinite(numeric) && numeric > 0
                ? toEpochMs(numeric)
                : undefined;
        }
        const parsed = Date.parse(trimmed);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }
    return undefined;
}

export function clampMtime(value: number, now: number = Date.now()): number {
    if (!Number.isFinite(value) || value <= 0) return now;
    return Math.min(Math.round(value), now + 24 * 60 * 60 * 1000);
}

export function randomId(): string {
    const bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        crypto.getRandomValues(bytes);
    } else {
        for (let index = 0; index < bytes.length; index++) {
            bytes[index] = Math.floor(Math.random() * 256);
        }
    }
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function forEachPool<T>(
    items: Iterable<T>,
    limit: number,
    fn: (item: T, index: number) => Promise<void>,
    shouldStop?: () => boolean,
): Promise<void> {
    const iterator = items[Symbol.iterator]();
    let index = 0;
    let processed = 0;
    let failure: unknown;
    let stopped = false;
    const workers = Array.from({ length: Math.max(1, limit) }, async () => {
        while (true) {
            if (stopped || shouldStop?.()) return;
            let next: IteratorResult<T>;
            try {
                next = iterator.next();
                if (next.done) return;
                await fn(next.value, index++);
                if (++processed % 256 === 0) await yieldToUI();
            } catch (error) {
                if (!stopped) {
                    stopped = true;
                    failure = error;
                }
                return;
            }
        }
    });
    await Promise.all(workers);
    if (stopped) throw failure;
}

type SchedulerLike = { yield?: () => Promise<void> };

let yieldQueue: Array<() => void> | null = null;
let yieldPort: MessagePort | null = null;

export function yieldToUI(): Promise<void> {
    const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler;
    if (scheduler?.yield) return scheduler.yield();
    if (typeof MessageChannel === "undefined") {
        return new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    }
    if (!yieldQueue || !yieldPort) {
        yieldQueue = [];
        const channel = new MessageChannel();
        yieldPort = channel.port2;
        channel.port1.onmessage = () => {
            yieldQueue?.shift()?.();
        };
    }
    const queue = yieldQueue;
    const port = yieldPort;
    return new Promise<void>((resolve) => {
        queue.push(resolve);
        port.postMessage(null);
    });
}

export function createYieldTicker(every = 256): () => Promise<void> | undefined {
    let count = 0;
    return () => (++count % every === 0 ? yieldToUI() : undefined);
}

export interface Limiter {
    acquire(weight: number): Promise<void>;
    release(weight: number): void;
}

// Bounds the sum of active weights, used for directory slots and file bytes.
export function createLimiter(capacity: number): Limiter {
    const limit = Math.max(1, Math.round(capacity));
    let active = 0;
    const waiters: Array<{ weight: number; resolve: () => void }> = [];
    let head = 0;
    const normalize = (weight: number): number =>
        Math.min(limit, Math.max(1, Math.ceil(Number.isFinite(weight) ? weight : 0)));
    const drain = (): void => {
        while (head < waiters.length) {
            const next = waiters[head];
            if (active + next.weight > limit) break;
            active += next.weight;
            waiters[head] = { weight: 0, resolve: () => {} };
            head++;
            next.resolve();
        }
        if (head > 1024 && head * 2 > waiters.length) {
            waiters.splice(0, head);
            head = 0;
        }
    };
    return {
        async acquire(weight: number): Promise<void> {
            const size = normalize(weight);
            if (head === waiters.length && active + size <= limit) {
                active += size;
                return;
            }
            await new Promise<void>((resolve) => {
                waiters.push({ weight: size, resolve });
            });
        },
        release(weight: number): void {
            active = Math.max(0, active - normalize(weight));
            drain();
        },
    };
}

export function normalizeVaultPath(path: string): string {
    return path.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

export function createPathRecord<T>(): Record<string, T> {
    return Object.create(null) as Record<string, T>;
}

export function isSafeManifestPath(path: string): boolean {
    if (!path || path.startsWith("/") || path.includes("\\")) return false;
    let bytes = 0;
    for (const character of path) {
        const code = character.codePointAt(0) ?? 0;
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        if (bytes > 1024) return false;
    }
    for (const segment of path.split("/")) {
        if (!segment || segment === "." || segment === "..") return false;
        if (/[\u0000-\u001f\u007f]/.test(segment)) return false;
    }
    return true;
}

export function normalizePrefix(prefix: string, fallback: string): string {
    const cleaned = prefix.trim()
        .replace(/\\/g, "/")
        .split("/")
        .filter((part) => part && part !== "." && part !== "..")
        .join("/")
        .replace(/^\/+|\/+$/g, "");
    return cleaned || fallback;
}

export function parentPaths(path: string): string[] {
    const parts = normalizeVaultPath(path).split("/");
    const parents: string[] = [];
    let current = "";
    for (let index = 0; index < parts.length - 1; index++) {
        current = current ? `${current}/${parts[index]}` : parts[index];
        parents.push(current);
    }
    return parents;
}

export function mimeForPath(path: string): string {
    const lastDot = path.lastIndexOf(".");
    if (lastDot < 0) return "application/octet-stream";
    const extension = path.slice(lastDot + 1).toLowerCase();
    return MIME_TYPES[extension] ?? "application/octet-stream";
}

export function normalizeSha256(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

export function stripQuotes(value: string): string {
    const trimmed = value.trim();
    return trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1)
        : trimmed;
}

export function quoteEtag(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    return trimmed.startsWith('"') ? trimmed : `"${trimmed}"`;
}

export function sideMtime(
    side: RemoteSide | undefined,
    fallback = 0,
): number {
    return side?.object?.mtime
        ?? side?.entry?.mtime
        ?? side?.object?.lastModified
        ?? fallback;
}

export function sideSize(
    side: RemoteSide | undefined,
    fallback = 0,
): number {
    return side?.object?.size ?? side?.entry?.size ?? fallback;
}

export function sideSha256(side: RemoteSide | undefined): string | undefined {
    return side?.object?.sha256 ?? side?.entry?.sha256;
}

export function sideEtag(side: RemoteSide | undefined): string | undefined {
    return side?.object?.etag ?? side?.entry?.etag;
}
