import type { App } from "obsidian";

import type {
    Baseline,
    BaselineEntry,
    ManifestEntry,
    RemoteObject,
    SyncResult,
} from "../core/types";
import {
    createPathRecord,
    createYieldTicker,
    errorText,
    forEachPool,
    normalizePrefix,
} from "../core/util";
import type { S3SyncSettings } from "../plugin/settings";
import type { S3Client } from "../s3/client";
import {
    baselineKey,
    createBaseline,
    getDeviceId,
    loadBaseline,
    saveBaseline,
} from "./baseline";
import { applyPlan } from "./executor";
import {
    ManifestConflictError,
    emptyManifest,
    loadManifest,
    manifestEntriesEqual,
    manifestKey,
    saveManifest,
    serializeManifest,
} from "./manifest";
import { buildPlan } from "./planner";
import { buildRemoteSnapshot } from "./remote";
import { scanVault, vaultIdentity } from "./vault";

const STALE_POOL = 8;
const MAX_ATTEMPTS = 3;

export interface SyncEngineOptions {
    app: App;
    client: S3Client;
    settings: S3SyncSettings;
    exclude: (path: string) => boolean;
    manifestPath: string;
    dataJsonPath: string;
    onProgress?: (done: number, total: number) => void;
    onStatus?: (text: string) => void;
    isCanceled?: () => boolean;
}

export class SyncEngine {
    private readonly app: App;
    private readonly client: S3Client;
    private readonly settings: S3SyncSettings;
    private readonly exclude: (path: string) => boolean;
    private readonly manifestPath: string;
    private readonly dataJsonPath: string;
    private readonly onProgress?: (done: number, total: number) => void;
    private readonly onStatus?: (text: string) => void;
    private readonly isCanceled?: () => boolean;
    private readonly prefix: string;
    private readonly prefixWithSlash: string;
    private readonly manifestKey: string;

    constructor(options: SyncEngineOptions) {
        this.app = options.app;
        this.client = options.client;
        this.settings = options.settings;
        this.exclude = options.exclude;
        this.manifestPath = options.manifestPath;
        this.dataJsonPath = options.dataJsonPath;
        this.onProgress = options.onProgress;
        this.onStatus = options.onStatus;
        this.isCanceled = options.isCanceled;
        this.prefix = normalizePrefix(
            options.settings.prefix,
            options.app.vault.getName().trim() || "vault",
        );
        this.prefixWithSlash = `${this.prefix}/`;
        this.manifestKey = manifestKey(this.prefix, this.manifestPath);
    }

    async run(): Promise<SyncResult> {
        const started = Date.now();
        const deviceId = await getDeviceId();
        const vaultName = this.app.vault.getName();
        const key = await baselineKey(
            this.settings.endpoint,
            this.settings.bucket,
            this.prefix,
            vaultIdentity(this.app),
        );
        let lastConflict: unknown;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                return await this.runOnce(deviceId, key, vaultName, started);
            } catch (error) {
                if (
                    error instanceof ManifestConflictError
                    && attempt < MAX_ATTEMPTS - 1
                ) {
                    lastConflict = error;
                    this.onStatus?.("manifest conflict; retrying");
                    continue;
                }
                throw error;
            }
        }
        throw lastConflict instanceof Error
            ? lastConflict
            : new Error("Sync failed after retries");
    }

    private async runOnce(
        deviceId: string,
        key: string,
        vaultName: string,
        started: number,
    ): Promise<SyncResult> {
        const now = Date.now();
        const tick = createYieldTicker();
        const previous = await loadBaseline(key);
        const baseline = previous ?? createBaseline(key, deviceId, vaultName);
        const initialized = previous?.initialized === true;
        const firstSync = !initialized;

        this.onStatus?.("loading manifest");
        const loaded = await loadManifest(
            this.client,
            this.manifestKey,
            this.manifestPath,
        );
        let manifest = loaded.manifest;
        let recovery = false;
        if (!manifest) {
            manifest = emptyManifest(this.prefix, vaultName, deviceId, now);
            recovery = initialized;
        }

        this.onStatus?.("scanning vault");
        let lastScanTick = 0;
        const localFiles = await scanVault(this.app, {
            exclude: this.exclude,
            isCanceled: this.isCanceled,
            onProgress: (directories, files) => {
                const now = Date.now();
                if (now - lastScanTick < 200) return;
                lastScanTick = now;
                this.onStatus?.(`scanning: ${directories} folders, ${files} files`);
            },
        });
        if (this.isCanceled?.()) throw new Error("Sync canceled");

        this.onStatus?.("listing remote objects");
        const snapshot = await buildRemoteSnapshot({
            client: this.client,
            manifest,
            manifestKey: this.manifestKey,
            manifestPath: this.manifestPath,
            prefixWithSlash: this.prefixWithSlash,
            exclude: this.exclude,
            localPaths: new Set(localFiles.keys()),
            onStatus: this.onStatus,
            isCanceled: this.isCanceled,
        });

        this.onStatus?.("planning");
        const planned = await buildPlan({
            app: this.app,
            localFiles,
            snapshot,
            manifest,
            manifestPath: this.manifestPath,
            baseline,
            initialized,
            exclude: this.exclude,
            isCanceled: this.isCanceled,
        });

        const changeCount = planned.actions.length;
        this.onStatus?.(
            changeCount > 0
                ? `applying ${changeCount} change${changeCount === 1 ? "" : "s"}`
                : "nothing to do",
        );
        const outcome = await applyPlan({
            app: this.app,
            client: this.client,
            actions: planned.actions,
            localFiles,
            snapshot,
            manifest,
            baseline,
            now,
            keyPrefix: this.prefixWithSlash,
            dataJsonPath: this.dataJsonPath,
            isCanceled: this.isCanceled,
            onProgress: this.onProgress,
        });

        if (this.isCanceled?.()) throw new Error("Sync canceled");

        const nextFiles = manifest.files;
        let manifestChanged = loaded.manifest === null;
        const applyEntry = (path: string, entry: ManifestEntry): void => {
            if (manifestEntriesEqual(nextFiles[path], entry)) return;
            nextFiles[path] = entry;
            manifestChanged = true;
        };
        for (const [path, entry] of snapshot.refreshedManifest) {
            const pause = tick();
            if (pause) await pause;
            applyEntry(path, entry);
        }
        for (const [path, entry] of outcome.manifestUpdates) {
            const pause = tick();
            if (pause) await pause;
            applyEntry(path, entry);
        }
        for (const path of outcome.manifestRemovals) {
            const pause = tick();
            if (pause) await pause;
            const entry = nextFiles[path];
            if (entry && !entry.deleted) {
                delete nextFiles[path];
                manifestChanged = true;
            }
        }

        const warnings = [...snapshot.warnings, ...planned.warnings];

        const stalePending: RemoteObject[] = [];
        for (const object of snapshot.staleObjects) {
            const pause = tick();
            if (pause) await pause;
            const entry = nextFiles[object.path];
            if (!entry || Boolean(entry.deleted)) stalePending.push(object);
        }

        const nextManifest = {
            ...manifest,
            deviceId,
            updatedAt: now,
            files: nextFiles,
        };
        let saved: { etag: string; usedConditional: boolean } | null = null;
        if (manifestChanged || stalePending.length > 0) {
            this.onStatus?.("writing manifest");
            saved = await saveManifest(
                this.client,
                this.manifestKey,
                nextManifest,
                loaded.etag,
                loaded.manifest !== null,
                baseline.conditionalPutUnsupported,
            );
        }
        if (stalePending.length > 0) {
            // Delete only after the tombstone state has been committed, so a
            // lost manifest race can never remove another device's new object.
            warnings.push(...await this.removeStaleObjects(stalePending));
        }

        const localManifest = saved ? nextManifest : manifest;
        try {
            const text = await serializeManifest(localManifest);
            await this.app.vault.adapter.write(this.manifestPath, text);
        } catch (error) {
            warnings.push(
                `Unable to write the local sync manifest: ${errorText(error)}`,
            );
        }

        const nextEntries = initialized
            ? baseline.entries
            : createPathRecord<BaselineEntry>();
        for (const [path, entry] of outcome.baselineUpdates) {
            const pause = tick();
            if (pause) await pause;
            nextEntries[path] = entry;
        }
        for (const path of outcome.baselineDeletes) {
            const pause = tick();
            if (pause) await pause;
            delete nextEntries[path];
        }

        const nextBaseline: Baseline = {
            schema: 1,
            key,
            deviceId,
            vault: vaultName,
            initialized: true,
            lastSyncAt: Date.now(),
            conditionalPutUnsupported:
                baseline.conditionalPutUnsupported
                || (saved !== null && !saved.usedConditional),
            entries: nextEntries,
        };
        if (saved && !saved.usedConditional && !baseline.conditionalPutUnsupported) {
            warnings.push(
                "The provider rejected conditional manifest updates, so the manifest " +
                "was saved without concurrency protection. Concurrent syncs from " +
                "multiple devices may overwrite each other's changes.",
            );
        }
        try {
            await saveBaseline(nextBaseline);
        } catch (error) {
            warnings.push(`Unable to save the local sync state: ${errorText(error)}`);
        }

        return {
            uploaded: outcome.uploaded,
            downloaded: outcome.downloaded,
            deletedLocal: outcome.deletedLocal,
            deletedRemote: outcome.deletedRemote,
            adopted: outcome.adopted,
            failed: outcome.failed,
            scanned: localFiles.size,
            errors: outcome.errors,
            warnings,
            firstSync,
            recovery,
            configFileUpdated: outcome.configFileUpdated,
            durationMs: Date.now() - started,
        };
    }

    private async removeStaleObjects(
        stale: RemoteObject[],
    ): Promise<string[]> {
        const warnings: string[] = [];
        await forEachPool(
            stale,
            STALE_POOL,
            async (object) => {
                if (this.isCanceled?.()) return;
                try {
                    await this.client.deleteObject(
                        `${this.prefixWithSlash}${object.path}`,
                    );
                } catch (error) {
                    warnings.push(
                        `Unable to remove stale object ${object.path}: ${errorText(error)}`,
                    );
                }
            },
            this.isCanceled,
        );
        return warnings;
    }
}
