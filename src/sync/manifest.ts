import type { Manifest, ManifestEntry } from "../core/types";
import {
    createPathRecord,
    createYieldTicker,
    encodeUtf8,
    isSafeManifestPath,
    sha256Hex,
} from "../core/util";
import { S3Client, S3Error } from "../s3/client";

export function manifestKey(prefix: string, manifestPath: string): string {
    return `${prefix}/${manifestPath}`;
}

export class ManifestConflictError extends Error {
    constructor(message = "The remote manifest changed during sync") {
        super(message);
        this.name = "ManifestConflictError";
    }
}

export function emptyManifest(
    prefix: string,
    vault: string,
    deviceId: string,
    now: number = Date.now(),
): Manifest {
    return {
        schema: 1,
        app: "obsidian-s3-sync",
        prefix,
        vault,
        deviceId,
        updatedAt: now,
        files: createPathRecord<ManifestEntry>(),
    };
}

export function manifestEntriesEqual(
    left: ManifestEntry | undefined,
    right: ManifestEntry | undefined,
): boolean {
    if (!left || !right) return left === right;
    return left.mtime === right.mtime
        && left.size === right.size
        && (left.sha256 || undefined) === (right.sha256 || undefined)
        && (left.etag || undefined) === (right.etag || undefined)
        && Boolean(left.deleted) === Boolean(right.deleted)
        && left.deletedAt === right.deletedAt;
}

async function parseManifest(
    text: string,
    manifestPath: string,
): Promise<Manifest> {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new Error("Remote manifest is not valid JSON; aborting sync");
    }
    if (!raw || typeof raw !== "object") {
        throw new Error("Remote manifest is invalid; aborting sync");
    }
    const data = raw as Partial<Manifest>;
    if (
        data.schema !== 1
        || data.app !== "obsidian-s3-sync"
        || !data.files
        || typeof data.files !== "object"
        || Array.isArray(data.files)
    ) {
        throw new Error("Remote manifest has an unsupported schema; aborting sync");
    }
    const rawFiles = data.files as Record<string, unknown>;
    const files = createPathRecord<ManifestEntry>();
    const reserved = manifestPath.toLowerCase();
    const tick = createYieldTicker();
    for (const path in rawFiles) {
        if (!Object.prototype.hasOwnProperty.call(rawFiles, path)) continue;
        const pause = tick();
        if (pause) await pause;
        const value = rawFiles[path];
        if (!isSafeManifestPath(path) || path.toLowerCase() === reserved) {
            throw new Error(`Remote manifest contains an invalid path: ${path}`);
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`Remote manifest entry is invalid: ${path}`);
        }
        const entry = value as Partial<ManifestEntry>;
        if (
            typeof entry.mtime !== "number"
            || !Number.isFinite(entry.mtime)
            || entry.mtime < 0
            || typeof entry.size !== "number"
            || !Number.isFinite(entry.size)
            || entry.size < 0
            || (entry.etag !== undefined && typeof entry.etag !== "string")
            || (entry.deleted !== undefined && typeof entry.deleted !== "boolean")
            || (entry.deletedAt !== undefined
                && (typeof entry.deletedAt !== "number"
                    || !Number.isFinite(entry.deletedAt)
                    || entry.deletedAt <= 0))
        ) {
            throw new Error(`Remote manifest entry is invalid: ${path}`);
        }
        let sha256: string | undefined;
        if (entry.sha256 !== undefined) {
            if (typeof entry.sha256 !== "string") {
                throw new Error(`Remote manifest entry is invalid: ${path}`);
            }
            sha256 = entry.sha256.trim().toLowerCase();
            if (!/^[a-f0-9]{64}$/.test(sha256)) {
                throw new Error(`Remote manifest entry is invalid: ${path}`);
            }
        }
        files[path] = {
            mtime: entry.mtime,
            size: entry.size,
            ...(sha256 ? { sha256 } : {}),
            ...(entry.etag ? { etag: entry.etag } : {}),
            ...(entry.deleted ? { deleted: true } : {}),
            ...(entry.deletedAt !== undefined ? { deletedAt: entry.deletedAt } : {}),
        };
    }
    return {
        schema: 1,
        app: "obsidian-s3-sync",
        prefix: typeof data.prefix === "string" ? data.prefix : "",
        vault: typeof data.vault === "string" ? data.vault : "",
        deviceId: typeof data.deviceId === "string" ? data.deviceId : "",
        updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
        files,
    };
}

export async function serializeManifest(manifest: Manifest): Promise<string> {
    const entries: string[] = [];
    const tick = createYieldTicker();
    for (const path in manifest.files) {
        const pause = tick();
        if (pause) await pause;
        entries.push(
            `${JSON.stringify(path)}:${JSON.stringify(manifest.files[path])}`,
        );
    }
    return (
        `{"schema":1,"app":"obsidian-s3-sync",` +
        `"prefix":${JSON.stringify(manifest.prefix)},` +
        `"vault":${JSON.stringify(manifest.vault)},` +
        `"deviceId":${JSON.stringify(manifest.deviceId)},` +
        `"updatedAt":${JSON.stringify(manifest.updatedAt)},` +
        `"files":{${entries.join(",")}}}`
    );
}

export async function loadManifest(
    client: S3Client,
    key: string,
    manifestPath: string,
): Promise<{ manifest: Manifest | null; etag: string }> {
    const object = await client.getObject(key);
    if (!object) return { manifest: null, etag: "" };
    const text = new TextDecoder().decode(object.body);
    return {
        manifest: await parseManifest(text, manifestPath),
        etag: object.etag,
    };
}

export async function saveManifest(
    client: S3Client,
    key: string,
    manifest: Manifest,
    etag: string,
    manifestExists: boolean,
    skipConditional: boolean,
): Promise<{ etag: string; usedConditional: boolean }> {
    const body = encodeUtf8(await serializeManifest(manifest));
    const sha256 = await sha256Hex(body);
    const base = {
        contentType: "application/json; charset=utf-8",
        mtime: manifest.updatedAt,
        sha256,
    };
    const condition = !manifestExists
        ? { ifNoneMatch: "*" }
        : etag
            ? { ifMatch: etag }
            : {};
    const canBeConditional = Boolean(condition.ifMatch || condition.ifNoneMatch);
    if (skipConditional || !canBeConditional) {
        const result = await client.putObject(key, body, base);
        return { etag: result.etag, usedConditional: false };
    }
    try {
        const result = await client.putObject(key, body, {
            ...base,
            ...condition,
        });
        return { etag: result.etag, usedConditional: true };
    } catch (error) {
        if (error instanceof S3Error && (error.status === 412 || error.status === 409)) {
            throw new ManifestConflictError();
        }
        if (
            error instanceof S3Error
            && (error.status === 400 || error.status === 501)
        ) {
            const result = await client.putObject(key, body, base);
            return { etag: result.etag, usedConditional: false };
        }
        throw error;
    }
}
