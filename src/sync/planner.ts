import type { App } from "obsidian";

import type {
    Baseline,
    BaselineEntry,
    LocalFile,
    Manifest,
    PlannedAction,
    RemoteSide,
} from "../core/types";
import {
    createLimiter,
    createYieldTicker,
    errorText,
    forEachPool,
    sideMtime,
    sideSha256,
    sideSize,
} from "../core/util";
import { decide } from "./decision";
import type { RemoteSnapshot } from "./remote";
import { hashVaultFile, sanitizeRemotePath } from "./vault";

const HASH_POOL = 4;
const HASH_BYTES = createLimiter(256 * 1024 * 1024);

export interface PlanInput {
    app: App;
    localFiles: Map<string, LocalFile>;
    snapshot: RemoteSnapshot;
    manifest: Manifest;
    manifestPath: string;
    baseline: Baseline;
    initialized: boolean;
    exclude: (path: string) => boolean;
    isCanceled?: () => boolean;
}

export interface PlanResult {
    actions: PlannedAction[];
    warnings: string[];
}

interface PathContext {
    local?: LocalFile;
    side?: RemoteSide;
    baselineEntry?: BaselineEntry;
    live?: RemoteSide;
    remoteMtime: number;
    remoteSha256?: string;
    remoteSize: number;
}

export async function buildPlan(input: PlanInput): Promise<PlanResult> {
    const {
        app,
        localFiles,
        snapshot,
        manifest,
        manifestPath,
        baseline,
        initialized,
        exclude,
    } = input;
    const tick = createYieldTicker();
    const paths = new Set<string>();
    for (const path of localFiles.keys()) {
        const pause = tick();
        if (pause) await pause;
        paths.add(path);
    }
    for (const path in manifest.files) {
        const pause = tick();
        if (pause) await pause;
        paths.add(path);
    }
    for (const path of snapshot.sides.keys()) {
        const pause = tick();
        if (pause) await pause;
        paths.add(path);
    }
    for (const path in baseline.entries) {
        const pause = tick();
        if (pause) await pause;
        paths.add(path);
    }
    const warnings: string[] = [];
    const skipped = new Set<string>();
    const reserved = manifestPath.toLowerCase();

    const localKeys = new Map<string, string>();
    for (const path of localFiles.keys()) {
        const pause = tick();
        if (pause) await pause;
        const key = path.normalize("NFC").toLowerCase();
        const existing = localKeys.get(key);
        if (existing && existing !== path) {
            warnings.push(
                `Local paths ${existing} and ${path} differ only by case ` +
                "or Unicode normalization",
            );
            continue;
        }
        localKeys.set(key, path);
    }
    const remoteKeys = new Map<string, string>();
    const collisions = new Set<string>();
    for (const path of paths) {
        const pause = tick();
        if (pause) await pause;
        if (localFiles.has(path) || exclude(path)) continue;
        const key = path.normalize("NFC").toLowerCase();
        const localMatch = localKeys.get(key);
        if (localMatch && localMatch !== path) {
            collisions.add(path);
            warnings.push(
                `Skipped ${path}: it collides with local path ${localMatch} ` +
                "on case-insensitive filesystems",
            );
            continue;
        }
        const remoteMatch = remoteKeys.get(key);
        if (remoteMatch) {
            collisions.add(path);
            warnings.push(
                `Skipped ${path}: it collides with remote path ${remoteMatch} ` +
                "on case-insensitive filesystems",
            );
            continue;
        }
        remoteKeys.set(key, path);
    }

    const contextFor = (path: string): PathContext => {
        const local = localFiles.get(path);
        const side = snapshot.sides.get(path);
        const baselineEntry = initialized ? baseline.entries[path] : undefined;
        const live = side && !side.entry?.deleted ? side : undefined;
        const remoteMtime = sideMtime(live);
        const remoteSha256 = sideSha256(live);
        const remoteSize = sideSize(live);
        return {
            local,
            side,
            baselineEntry,
            live,
            remoteMtime,
            remoteSha256,
            remoteSize,
        };
    };

    const hashQueue: string[] = [];
    for (const path of paths) {
        const pause = tick();
        if (pause) await pause;
        if (path.toLowerCase() === reserved) {
            skipped.add(path);
            continue;
        }
        if (exclude(path)) {
            skipped.add(path);
            continue;
        }
        if (!sanitizeRemotePath(path, manifestPath)) {
            warnings.push(`Skipped non-portable vault path: ${path}`);
            skipped.add(path);
            continue;
        }
        if (snapshot.unknownPaths.has(path) || collisions.has(path)) {
            skipped.add(path);
            continue;
        }

        const {
            local,
            baselineEntry,
            live,
            remoteMtime,
            remoteSha256,
            remoteSize,
        } = contextFor(path);
        const touchCandidate = Boolean(
            local
            && live
            && baselineEntry
            && baselineEntry.sha256
            && local.size === baselineEntry.size
            && local.mtime !== baselineEntry.mtime,
        );
        const equalityCandidate = Boolean(
            local
            && live
            && remoteSha256
            && local.size === remoteSize
            && (
                local.mtime === remoteMtime
                || (!initialized && remoteMtime > local.mtime)
            ),
        );
        if (touchCandidate || equalityCandidate) hashQueue.push(path);
    }

    const hashes = new Map<string, string>();
    await forEachPool(
        hashQueue,
        HASH_POOL,
        async (path) => {
            if (input.isCanceled?.()) return;
            const bytes = localFiles.get(path)?.size ?? 0;
            await HASH_BYTES.acquire(bytes);
            try {
                if (input.isCanceled?.()) return;
                hashes.set(path, await hashVaultFile(app, path));
            } catch (error) {
                warnings.push(`Unable to hash ${path}: ${errorText(error)}`);
                skipped.add(path);
            } finally {
                HASH_BYTES.release(bytes);
            }
        },
        input.isCanceled,
    );

    if (input.isCanceled?.()) return { actions: [], warnings };

    const actions: PlannedAction[] = [];
    for (const path of paths) {
        const pause = tick();
        if (pause) {
            await pause;
            if (input.isCanceled?.()) return { actions: [], warnings };
        }
        if (skipped.has(path)) continue;
        const { local, side, baselineEntry, remoteMtime } = contextFor(path);
        let action: PlannedAction;
        try {
            action = decide({
                path,
                local: local
                    ? { ...local, sha256: hashes.get(path) }
                    : undefined,
                remote: side,
                baseline: baselineEntry,
                initialized,
            });
        } catch (error) {
            warnings.push(`Unable to plan ${path}: ${errorText(error)}`);
            continue;
        }

        if (action.kind === "none") {
            if (local) {
                const unchanged = Boolean(
                    side?.entry
                    && !side.entry.deleted
                    && baselineEntry
                    && local.mtime === baselineEntry.mtime
                    && local.size === baselineEntry.size,
                );
                if (unchanged) {
                    // A platform that ignored the mtime must not be retried forever.
                    if (baselineEntry?.mtimeExact === false) continue;
                    if (local.mtime === remoteMtime) continue;
                }
            } else {
                const manifestEntry = manifest.files[path];
                if (!baselineEntry && (!manifestEntry || manifestEntry.deleted)) {
                    continue;
                }
            }
        }
        actions.push(action);
    }

    return { actions, warnings };
}
