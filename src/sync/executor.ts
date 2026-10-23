import type { App } from "obsidian";

import type {
    ActionKind,
    Baseline,
    BaselineEntry,
    LocalFile,
    Manifest,
    ManifestEntry,
    PlannedAction,
} from "../core/types";
import {
    MTIME_TOLERANCE_MS,
    clampMtime,
    createLimiter,
    createYieldTicker,
    errorText,
    forEachPool,
    mimeForPath,
    sideEtag,
    sideMtime,
    sideSha256,
    sideSize,
    toEpochMs,
} from "../core/util";
import type { S3Client } from "../s3/client";
import { manifestEntriesEqual } from "./manifest";
import type { RemoteSnapshot } from "./remote";
import {
    deleteVaultFile,
    notifyVault,
    readVaultFile,
    setVaultMtime,
    writeVaultFile,
} from "./vault";

const TRANSFER_POOL = 4;
const TRANSFER_BYTES = createLimiter(256 * 1024 * 1024);

export interface PlanOutcome {
    uploaded: number;
    downloaded: number;
    deletedLocal: number;
    deletedRemote: number;
    adopted: number;
    failed: number;
    errors: string[];
    configFileUpdated: boolean;
    baselineUpdates: Map<string, BaselineEntry>;
    baselineDeletes: Set<string>;
    manifestUpdates: Map<string, ManifestEntry>;
    manifestRemovals: Set<string>;
}

export interface ApplyInput {
    app: App;
    client: S3Client;
    actions: PlannedAction[];
    localFiles: Map<string, LocalFile>;
    snapshot: RemoteSnapshot;
    manifest: Manifest;
    baseline: Baseline;
    now: number;
    keyPrefix: string;
    dataJsonPath: string;
    isCanceled?: () => boolean;
    onProgress?: (done: number, total: number) => void;
}

interface Context extends ApplyInput {
    outcome: PlanOutcome;
    done: number;
    total: number;
}

export async function applyPlan(input: ApplyInput): Promise<PlanOutcome> {
    const outcome: PlanOutcome = {
        uploaded: 0,
        downloaded: 0,
        deletedLocal: 0,
        deletedRemote: 0,
        adopted: 0,
        failed: 0,
        errors: [],
        configFileUpdated: false,
        baselineUpdates: new Map<string, BaselineEntry>(),
        baselineDeletes: new Set<string>(),
        manifestUpdates: new Map<string, ManifestEntry>(),
        manifestRemovals: new Set<string>(),
    };
    const total = input.actions.filter((action) => action.kind !== "none").length;
    const context: Context = { ...input, outcome, done: 0, total };

    await applyUploads(context);
    if (canceled(context)) return outcome;
    await applyDownloads(context);
    if (canceled(context)) return outcome;
    await applyLocalDeletes(context);
    if (canceled(context)) return outcome;
    await applyRemoteDeletes(context);
    if (canceled(context)) return outcome;
    await applyAdopts(context);
    if (canceled(context)) return outcome;
    await applyNoOps(context);
    return outcome;
}

async function runActions(
    context: Context,
    kind: Exclude<ActionKind, "none">,
    failureLabel: string,
    handler: (action: PlannedAction) => Promise<void>,
): Promise<void> {
    const actions = context.actions.filter((action) => action.kind === kind);
    await forEachPool(
        actions,
        TRANSFER_POOL,
        async (action) => {
            if (canceled(context)) return;
            try {
                await handler(action);
            } catch (error) {
                recordFailure(
                    context,
                    action.path,
                    `${failureLabel}: ${errorText(error)}`,
                );
            } finally {
                tick(context);
            }
        },
        () => canceled(context),
    );
}

async function applyUploads(context: Context): Promise<void> {
    await runActions(context, "upload", "upload failed", async (action) => {
        const stat = await context.app.vault.adapter.stat(action.path);
        if (!stat) throw new Error("the file disappeared before upload");
        const preMtime = toEpochMs(stat.mtime) ?? context.now;
        await TRANSFER_BYTES.acquire(stat.size);
        try {
            const content = await readVaultFile(context.app, action.path);
            const side = context.snapshot.sides.get(action.path);
            const prior = context.baseline.entries[action.path];
            const remoteSha256 = side?.entry?.deleted
                ? undefined
                : sideSha256(side);
            const remoteMtime = sideMtime(side, preMtime);
            const remoteSize = sideSize(side);
            const etag = sideEtag(side) || "";
            const syntheticLocal = prior?.mtimeExact === false;

            if (
                remoteSha256
                && remoteSha256 === content.sha256
                && remoteSize === content.size
            ) {
                const entry: BaselineEntry = {
                    mtime: preMtime,
                    size: content.size,
                    sha256: content.sha256,
                    ...(etag ? { etag } : {}),
                    ...(syntheticLocal ? { mtimeExact: false } : {}),
                };
                const manifestMtime = syntheticLocal
                    ? remoteMtime || preMtime
                    : Math.max(preMtime, remoteMtime);
                context.outcome.baselineUpdates.set(action.path, entry);
                context.outcome.manifestUpdates.set(action.path, {
                    mtime: manifestMtime,
                    size: content.size,
                    sha256: content.sha256,
                    ...(etag ? { etag } : {}),
                });
                context.outcome.adopted++;
                return;
            }

            const result = await context.client.putObject(
                `${context.keyPrefix}${action.path}`,
                content.body,
                {
                    contentType: mimeForPath(action.path),
                    mtime: preMtime,
                    sha256: content.sha256,
                },
            );
            const entry: BaselineEntry = {
                mtime: preMtime,
                size: content.size,
                sha256: content.sha256,
                ...(result.etag ? { etag: result.etag } : {}),
            };
            context.outcome.baselineUpdates.set(action.path, entry);
            context.outcome.manifestUpdates.set(action.path, { ...entry });
            context.outcome.uploaded++;
        } finally {
            TRANSFER_BYTES.release(stat.size);
        }
    });
}

async function applyDownloads(context: Context): Promise<void> {
    await runActions(context, "download", "download failed", async (action) => {
        const side = context.snapshot.sides.get(action.path);
        const expectedSize = sideSize(side, action.remote?.size ?? 0);
        await TRANSFER_BYTES.acquire(expectedSize);
        try {
            const object = await context.client.getObject(
                `${context.keyPrefix}${action.path}`,
            );
            if (!object) throw new Error("the object disappeared before download");
            const existed = await context.app.vault.adapter.exists(action.path);
            const expected =
                object.sha256
                ?? sideSha256(side)
                ?? action.remote?.sha256;
            const remoteMtime = clampMtime(
                object.mtime
                ?? side?.object?.mtime
                ?? side?.entry?.mtime
                ?? action.remote?.mtime
                ?? object.lastModified
                ?? context.now,
            );
            const planned = context.localFiles.get(action.path);
            const current = await context.app.vault.adapter.stat(action.path);
            if (current) {
                const currentMtime = toEpochMs(current.mtime) ?? 0;
                if (
                    (!planned || currentMtime !== planned.mtime)
                    && currentMtime > remoteMtime
                ) {
                    throw new Error("the local file changed during sync; download skipped");
                }
            }
            const written = await writeVaultFile(
                context.app,
                action.path,
                object.body,
                expected,
                remoteMtime,
            );
            const etag = object.etag || sideEtag(side) || "";
            const entry: BaselineEntry = {
                mtime: written.mtime,
                size: written.size,
                sha256: written.sha256,
                ...(etag ? { etag } : {}),
                ...(written.mtimeExact ? {} : { mtimeExact: false }),
            };
            context.outcome.baselineUpdates.set(action.path, entry);
            context.outcome.manifestUpdates.set(action.path, {
                mtime: remoteMtime,
                size: written.size,
                sha256: written.sha256,
                ...(etag ? { etag } : {}),
            });
            context.outcome.downloaded++;
            if (action.path === context.dataJsonPath) {
                context.outcome.configFileUpdated = true;
            }
            notifyVault(context.app, action.path, existed ? "modify" : "create");
        } finally {
            TRANSFER_BYTES.release(expectedSize);
        }
    });
}

async function applyLocalDeletes(context: Context): Promise<void> {
    await runActions(context, "deleteLocal", "local delete failed", async (action) => {
        const planned = context.localFiles.get(action.path);
        const current = await context.app.vault.adapter.stat(action.path);
        if (planned && current) {
            const currentMtime = toEpochMs(current.mtime);
            if (currentMtime !== undefined && currentMtime !== planned.mtime) {
                throw new Error("the local file changed during sync; deletion skipped");
            }
        }
        await deleteVaultFile(context.app, action.path);
        context.outcome.baselineDeletes.add(action.path);
        context.outcome.deletedLocal++;
        notifyVault(context.app, action.path, "delete");
    });
}

async function applyRemoteDeletes(context: Context): Promise<void> {
    await runActions(context, "deleteRemote", "remote delete failed", async (action) => {
        const side = context.snapshot.sides.get(action.path);
        const expectedEtag = side?.object?.etag;
        if (expectedEtag) {
            const head = await context.client.headObject(
                `${context.keyPrefix}${action.path}`,
            );
            if (head && head.etag && head.etag !== expectedEtag) {
                throw new Error("the remote object changed during sync; deletion skipped");
            }
        }
        await context.client.deleteObject(`${context.keyPrefix}${action.path}`);
        const prior = context.baseline.entries[action.path];
        const deletedAt = Date.now();
        const tombstone: ManifestEntry = {
            mtime: sideMtime(side, prior?.mtime ?? deletedAt),
            size: sideSize(side, prior?.size ?? 0),
            deleted: true,
            deletedAt,
        };
        context.outcome.manifestUpdates.set(action.path, tombstone);
        context.outcome.baselineDeletes.add(action.path);
        context.outcome.deletedRemote++;
    });
}

async function applyAdopts(context: Context): Promise<void> {
    await runActions(context, "adopt", "adopt failed", async (action) => {
        const local = context.localFiles.get(action.path);
        if (!local) throw new Error("the local file disappeared");
        const current = await context.app.vault.adapter.stat(action.path);
        const currentMtime = toEpochMs(current?.mtime);
        if (
            !current
            || current.size !== local.size
            || (currentMtime !== undefined && currentMtime !== local.mtime)
        ) {
            throw new Error("the local file changed during sync; adoption skipped");
        }
        const side = context.snapshot.sides.get(action.path);
        const prior = context.baseline.entries[action.path];
        const syntheticLocal = prior?.mtimeExact === false;
        const remoteMtime = sideMtime(side);
        const desired = syntheticLocal
            ? remoteMtime
            : Math.max(local.mtime, action.adoptMtime ?? local.mtime);
        if (desired > local.mtime) {
            await setVaultMtime(context.app, action.path, desired);
        }
        const stat = await context.app.vault.adapter.stat(action.path);
        const actualMtime = toEpochMs(stat?.mtime) ?? local.mtime;
        const size = stat?.size ?? local.size;
        const sha256 = sideSha256(side);
        const etag = sideEtag(side);
        const attempted = desired > local.mtime;
        const aligned = desired > 0
            && Math.abs(actualMtime - desired) <= MTIME_TOLERANCE_MS;
        const exact = syntheticLocal ? aligned : (!attempted || aligned);
        const manifestMtime = syntheticLocal
            ? (aligned && desired > 0
                ? Math.max(actualMtime, desired)
                : desired || actualMtime)
            : Math.max(actualMtime, desired);
        const entry: BaselineEntry = {
            mtime: actualMtime,
            size,
            ...(sha256 ? { sha256 } : {}),
            ...(etag ? { etag } : {}),
            ...(exact ? {} : { mtimeExact: false }),
        };
        context.outcome.baselineUpdates.set(action.path, entry);
        context.outcome.manifestUpdates.set(action.path, {
            mtime: manifestMtime,
            size,
            ...(sha256 ? { sha256 } : {}),
            ...(etag ? { etag } : {}),
        });
        context.outcome.adopted++;
    });
}

async function applyNoOps(context: Context): Promise<void> {
    const tick = createYieldTicker();
    for (const action of context.actions) {
        if (action.kind !== "none") continue;
        if (canceled(context)) return;
        const pause = tick();
        if (pause) {
            await pause;
            if (canceled(context)) return;
        }
        const local = context.localFiles.get(action.path);
        const side = context.snapshot.sides.get(action.path);
        if (local) {
            try {
                const current = await context.app.vault.adapter.stat(action.path);
                const currentMtime = toEpochMs(current?.mtime);
                if (
                    !current
                    || current.size !== local.size
                    || (currentMtime !== undefined && currentMtime !== local.mtime)
                ) {
                    continue;
                }
            } catch {
                continue;
            }
        }
        if (!local) {
            if (!side || side.entry?.deleted) {
                context.outcome.baselineDeletes.add(action.path);
                const entry = context.manifest.files[action.path];
                if (entry && !entry.deleted) {
                    context.outcome.manifestRemovals.add(action.path);
                }
            }
            continue;
        }
        const tracked = Boolean(side?.entry && !side.entry.deleted);
        const baseEntry: ManifestEntry | undefined =
            tracked && side?.entry
                ? context.snapshot.refreshedManifest.get(action.path) ?? side.entry
                : side?.object
                    ? {
                        mtime: side.object.mtime ?? side.object.lastModified,
                        size: side.object.size,
                        ...(side.object.sha256 ? { sha256: side.object.sha256 } : {}),
                        ...(side.object.etag ? { etag: side.object.etag } : {}),
                    }
                    : undefined;
        if (!baseEntry) {
            if (context.baseline.entries[action.path]) {
                context.outcome.baselineDeletes.add(action.path);
            }
            continue;
        }
        const prior = context.baseline.entries[action.path];
        const syntheticLocal = prior?.mtimeExact === false;
        const remoteMtime = baseEntry.mtime;
        const wanted = syntheticLocal
            ? remoteMtime
            : Math.max(local.mtime, remoteMtime);
        let localMtime = local.mtime;
        let localSize = local.size;
        if (wanted > local.mtime) {
            try {
                await setVaultMtime(context.app, action.path, wanted);
                const stat = await context.app.vault.adapter.stat(action.path);
                localMtime = toEpochMs(stat?.mtime) ?? local.mtime;
                localSize = stat?.size ?? local.size;
            } catch {}
        }
        const attempted = wanted > local.mtime;
        const aligned = wanted > 0
            && Math.abs(localMtime - wanted) <= MTIME_TOLERANCE_MS;
        const exact = syntheticLocal ? aligned : (!attempted || aligned);
        const manifestMtime = syntheticLocal && !exact
            ? remoteMtime
            : Math.max(localMtime, remoteMtime);
        const nextManifestEntry: ManifestEntry = {
            ...baseEntry,
            mtime: manifestMtime,
        };
        if (!tracked || !manifestEntriesEqual(baseEntry, nextManifestEntry)) {
            context.outcome.manifestUpdates.set(action.path, nextManifestEntry);
        }
        const nextBaselineEntry: BaselineEntry = {
            mtime: localMtime,
            size: localSize,
            ...(baseEntry.sha256 ? { sha256: baseEntry.sha256 } : {}),
            ...(baseEntry.etag ? { etag: baseEntry.etag } : {}),
            ...(exact ? {} : { mtimeExact: false }),
        };
        if (!baselineEntriesEqual(prior, nextBaselineEntry)) {
            context.outcome.baselineUpdates.set(action.path, nextBaselineEntry);
        }
    }
}

function canceled(context: Context): boolean {
    return context.isCanceled?.() === true;
}

function tick(context: Context): void {
    context.done++;
    context.onProgress?.(context.done, context.total);
}

function recordFailure(context: Context, path: string, message: string): void {
    context.outcome.failed++;
    if (context.outcome.errors.length < 100) {
        context.outcome.errors.push(`${path}: ${message}`);
    }
}

function baselineEntriesEqual(
    left: BaselineEntry | undefined,
    right: BaselineEntry,
): boolean {
    if (!left) return false;
    return left.mtime === right.mtime
        && left.size === right.size
        && (left.sha256 || undefined) === (right.sha256 || undefined)
        && (left.etag || undefined) === (right.etag || undefined)
        && (left.mtimeExact !== false) === (right.mtimeExact !== false);
}
