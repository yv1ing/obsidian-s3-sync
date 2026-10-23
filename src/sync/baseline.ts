import type { Baseline, BaselineEntry } from "../core/types";
import { createPathRecord, createYieldTicker, randomId, sha256Hex } from "../core/util";

const DB_NAME = "obsidian-s3-sync";
const DB_VERSION = 1;
const BASELINE_STORE = "baselines";
const META_STORE = "meta";
const LOCAL_STORAGE_PREFIX = "obsidian-s3-sync:baseline:v1:";
const LOCAL_SUMMARY_PREFIX = "obsidian-s3-sync:summary:v1:";
const SUMMARY_PREFIX = "summary:";
const DEVICE_ID_KEY = "obsidian-s3-sync:device-id";
const DB_OPEN_TIMEOUT_MS = 10_000;

let dbUnavailable = false;

function openDb(): Promise<IDBDatabase> {
    if (dbUnavailable) return Promise.reject(new Error("IndexedDB is unavailable"));
    return new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
            dbUnavailable = true;
            reject(new Error("IndexedDB is unavailable"));
            return;
        }
        let settled = false;
        const timer = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            dbUnavailable = true;
            reject(new Error("IndexedDB open timed out"));
        }, DB_OPEN_TIMEOUT_MS);
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            dbUnavailable = true;
            reject(error);
        };
        let request: IDBOpenDBRequest;
        try {
            request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (error) {
            fail(error);
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(BASELINE_STORE)) {
                db.createObjectStore(BASELINE_STORE);
            }
            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE);
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            if (settled) {
                db.close();
                return;
            }
            settled = true;
            window.clearTimeout(timer);
            resolve(db);
        };
        request.onerror = () => fail(
            request.error ?? new Error("IndexedDB open failed"),
        );
        request.onblocked = () => fail(new Error("IndexedDB open was blocked"));
    });
}

async function readStore<T>(store: string, key: string): Promise<T | undefined> {
    const db = await openDb();
    try {
        return await new Promise<T | undefined>((resolve, reject) => {
            const transaction = db.transaction(store, "readonly");
            const request = transaction.objectStore(store).get(key);
            let value: T | undefined;
            request.onsuccess = () => {
                value = request.result as T | undefined;
            };
            transaction.oncomplete = () => resolve(value);
            transaction.onerror = () => reject(
                transaction.error ?? new Error("IndexedDB read failed"),
            );
            transaction.onabort = () => reject(
                transaction.error ?? new Error("IndexedDB read aborted"),
            );
        });
    } finally {
        db.close();
    }
}

async function writeStore(
    store: string,
    operation: (objectStore: IDBObjectStore) => void,
): Promise<void> {
    const db = await openDb();
    try {
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(store, "readwrite");
            operation(transaction.objectStore(store));
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(
                transaction.error ?? new Error("IndexedDB write failed"),
            );
            transaction.onabort = () => reject(
                transaction.error ?? new Error("IndexedDB write aborted"),
            );
        });
    } finally {
        db.close();
    }
}

export interface BaselineSummary {
    deviceId: string;
    initialized: boolean;
    lastSyncAt: number;
}

function summaryOf(baseline: Baseline): BaselineSummary {
    return {
        deviceId: baseline.deviceId,
        initialized: baseline.initialized,
        lastSyncAt: baseline.lastSyncAt,
    };
}

function isSummary(value: unknown): value is BaselineSummary {
    if (!value || typeof value !== "object") return false;
    const summary = value as Partial<BaselineSummary>;
    return typeof summary.deviceId === "string"
        && typeof summary.initialized === "boolean"
        && typeof summary.lastSyncAt === "number"
        && Number.isFinite(summary.lastSyncAt);
}

async function writeSummary(baseline: Baseline): Promise<void> {
    const summary = summaryOf(baseline);
    try {
        await writeStore(META_STORE, (store) => {
            store.put(summary, SUMMARY_PREFIX + baseline.key);
        });
    } catch {}
    try {
        window.localStorage.setItem(
            LOCAL_SUMMARY_PREFIX + baseline.key,
            JSON.stringify(summary),
        );
    } catch {}
}

export async function loadBaselineSummary(
    key: string,
): Promise<BaselineSummary | null> {
    let indexed: BaselineSummary | null = null;
    try {
        const value = await readStore<BaselineSummary>(
            META_STORE,
            SUMMARY_PREFIX + key,
        );
        if (isSummary(value)) indexed = value;
    } catch {}
    let local: BaselineSummary | null = null;
    try {
        const raw = window.localStorage.getItem(LOCAL_SUMMARY_PREFIX + key);
        const value: unknown = raw ? JSON.parse(raw) : null;
        if (isSummary(value)) local = value;
    } catch {}
    if (indexed && local) {
        return local.lastSyncAt > indexed.lastSyncAt ? local : indexed;
    }
    return indexed ?? local;
}

async function removeSummary(key: string): Promise<void> {
    try {
        await writeStore(META_STORE, (store) => {
            store.delete(SUMMARY_PREFIX + key);
        });
    } catch {}
    try {
        window.localStorage.removeItem(LOCAL_SUMMARY_PREFIX + key);
    } catch {}
}

export async function getDeviceId(): Promise<string> {
    try {
        const existing = await readStore<string>(META_STORE, "deviceId");
        if (existing) return existing;
        const created = randomId();
        await writeStore(META_STORE, (store) => {
            store.put(created, "deviceId");
        });
        return created;
    } catch {
        try {
            const existing = window.localStorage.getItem(DEVICE_ID_KEY);
            if (existing) return existing;
            const created = randomId();
            window.localStorage.setItem(DEVICE_ID_KEY, created);
            return created;
        } catch {
            return randomId();
        }
    }
}

export async function baselineKey(
    endpoint: string,
    bucket: string,
    prefix: string,
    vaultIdentity: string,
): Promise<string> {
    const trimmed = endpoint.trim().toLowerCase();
    const normalizedEndpoint = (
        /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    ).replace(/\/+$/, "");
    return sha256Hex([
        normalizedEndpoint,
        bucket.trim(),
        prefix,
        vaultIdentity,
    ].join("\n"));
}

export function createBaseline(
    key: string,
    deviceId: string,
    vault: string,
): Baseline {
    return {
        schema: 1,
        key,
        deviceId,
        vault,
        initialized: false,
        lastSyncAt: 0,
        conditionalPutUnsupported: false,
        entries: createPathRecord<BaselineEntry>(),
    };
}

function isUsableBaseline(
    record: Baseline | null,
    key: string,
): record is Baseline {
    return Boolean(
        record
        && record.schema === 1
        && record.key === key
        && typeof record.deviceId === "string"
        && typeof record.initialized === "boolean"
        && typeof record.lastSyncAt === "number"
        && Number.isFinite(record.lastSyncAt)
        && record.entries
        && typeof record.entries === "object"
        && !Array.isArray(record.entries),
    );
}

export async function loadBaseline(key: string): Promise<Baseline | null> {
    let primary: Baseline | null = null;
    try {
        primary = (await readStore<Baseline>(BASELINE_STORE, key)) ?? null;
    } catch {
        primary = null;
    }
    let fallback: Baseline | null = null;
    try {
        const raw = window.localStorage.getItem(LOCAL_STORAGE_PREFIX + key);
        fallback = raw ? (JSON.parse(raw) as Baseline) : null;
    } catch {
        fallback = null;
    }

    let record: Baseline | null = null;
    if (primary && isUsableBaseline(primary, key)) {
        record = primary;
        if (fallback && isUsableBaseline(fallback, key)) {
            if (fallback.lastSyncAt > primary.lastSyncAt) {
                record = fallback;
            } else {
                try {
                    window.localStorage.removeItem(LOCAL_STORAGE_PREFIX + key);
                } catch {}
            }
        }
    } else if (fallback && isUsableBaseline(fallback, key)) {
        record = fallback;
    }
    if (!record) return null;

    const entries = createPathRecord<BaselineEntry>();
    const tick = createYieldTicker();
    for (const path in record.entries) {
        if (!Object.prototype.hasOwnProperty.call(record.entries, path)) continue;
        const entry = record.entries[path];
        if (
            entry
            && typeof entry === "object"
            && typeof entry.mtime === "number"
            && Number.isFinite(entry.mtime)
            && entry.mtime >= 0
            && typeof entry.size === "number"
            && Number.isFinite(entry.size)
            && entry.size >= 0
            && (entry.sha256 === undefined || typeof entry.sha256 === "string")
            && (entry.etag === undefined || typeof entry.etag === "string")
        ) {
            entries[path] = entry;
        }
        const pause = tick();
        if (pause) await pause;
    }
    record.entries = entries;
    return record;
}

export async function saveBaseline(baseline: Baseline): Promise<void> {
    try {
        await writeStore(BASELINE_STORE, (store) => {
            store.put(baseline, baseline.key);
        });
        try {
            window.localStorage.removeItem(LOCAL_STORAGE_PREFIX + baseline.key);
        } catch {}
    } catch {
        window.localStorage.setItem(
            LOCAL_STORAGE_PREFIX + baseline.key,
            JSON.stringify(baseline),
        );
    }
    await writeSummary(baseline);
}

export async function resetBaseline(key: string): Promise<void> {
    try {
        await writeStore(BASELINE_STORE, (store) => {
            store.delete(key);
        });
    } catch {}
    try {
        window.localStorage.removeItem(LOCAL_STORAGE_PREFIX + key);
    } catch {}
    await removeSummary(key);
}
