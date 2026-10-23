import { normalizePrefix } from "../core/util";

const DEFAULT_EXCLUDES = [".git/", ".trash/"];

export interface S3SyncSettings {
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
    excludePatterns: string[];
    syncOnStartup: boolean;
}

const EMPTY_SETTINGS: S3SyncSettings = {
    endpoint: "",
    bucket: "",
    region: "",
    accessKeyId: "",
    secretAccessKey: "",
    prefix: "",
    excludePatterns: [...DEFAULT_EXCLUDES],
    syncOnStartup: false,
};

function normalizeExcludes(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof value === "string") {
        return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
    return [...DEFAULT_EXCLUDES];
}

export function normalizeSettings(
    raw: Partial<S3SyncSettings> | null,
    vaultName: string,
): S3SyncSettings {
    const merged = { ...EMPTY_SETTINGS, ...(raw ?? {}) };
    return {
        endpoint: String(merged.endpoint ?? "").trim(),
        bucket: String(merged.bucket ?? "").trim(),
        region: String(merged.region ?? "").trim(),
        accessKeyId: String(merged.accessKeyId ?? "").trim(),
        secretAccessKey: String(merged.secretAccessKey ?? "").trim(),
        prefix: normalizePrefix(
            String(merged.prefix ?? ""),
            vaultName.trim() || "vault",
        ),
        excludePatterns: normalizeExcludes(merged.excludePatterns),
        syncOnStartup: merged.syncOnStartup !== false,
    };
}
