import type {
    Manifest,
    ManifestEntry,
    RemoteObject,
    RemoteSide,
} from "../core/types";
import { createYieldTicker, errorText, forEachPool } from "../core/util";
import type { S3Client } from "../s3/client";
import { sanitizeRemotePath } from "./vault";

const HEAD_POOL = 8;

export interface RemoteSnapshot {
    sides: Map<string, RemoteSide>;
    refreshedManifest: Map<string, ManifestEntry>;
    staleObjects: RemoteObject[];
    unknownPaths: Set<string>;
    warnings: string[];
}

export interface RemoteSnapshotInput {
    client: S3Client;
    manifest: Manifest;
    manifestKey: string;
    manifestPath: string;
    prefixWithSlash: string;
    exclude: (path: string) => boolean;
    localPaths: Set<string>;
    onStatus?: (text: string) => void;
    isCanceled?: () => boolean;
}

export async function buildRemoteSnapshot(
    input: RemoteSnapshotInput,
): Promise<RemoteSnapshot> {
    const {
        client,
        manifest,
        manifestKey,
        manifestPath,
        prefixWithSlash,
        exclude,
        localPaths,
        onStatus,
        isCanceled,
    } = input;
    const tick = createYieldTicker();
    const objects = new Map<string, RemoteObject>();
    const warnings: string[] = [];
    const emptySnapshot = (): RemoteSnapshot => ({
        sides: new Map(),
        refreshedManifest: new Map(),
        staleObjects: [],
        unknownPaths: new Set(),
        warnings,
    });

    await client.listObjects(prefixWithSlash, { shouldStop: isCanceled }, (item) => {
        if (!item.key.startsWith(prefixWithSlash)) return;
        if (item.key === manifestKey) return;
        if (item.key.endsWith("/")) return;
        const relative = item.key.slice(prefixWithSlash.length);
        if (!relative || exclude(relative)) return;
        if (!sanitizeRemotePath(relative, manifestPath)) {
            warnings.push(`Skipped unsafe remote key: ${relative}`);
            return;
        }
        objects.set(relative, {
            path: relative,
            size: item.size,
            etag: item.etag,
            lastModified: item.lastModified,
        });
    });

    if (isCanceled?.()) return emptySnapshot();

    const sides = new Map<string, RemoteSide>();
    const headQueue = new Set<string>();
    const staleObjects: RemoteObject[] = [];
    const allPaths = new Set<string>();
    for (const path in manifest.files) {
        const pause = tick();
        if (pause) await pause;
        if (!exclude(path) && sanitizeRemotePath(path, manifestPath)) {
            allPaths.add(path);
        }
    }
    for (const path of objects.keys()) {
        const pause = tick();
        if (pause) await pause;
        allPaths.add(path);
    }

    for (const path of allPaths) {
        const pause = tick();
        if (pause) {
            await pause;
            if (isCanceled?.()) return emptySnapshot();
        }
        const entry = manifest.files[path];
        const object = objects.get(path);
        if (entry?.deleted) {
            if (!object) {
                sides.set(path, { entry });
                continue;
            }
            const deletedAt = entry.deletedAt ?? entry.mtime ?? 0;
            if (object.lastModified > deletedAt + 1000) {
                const revived: ManifestEntry = {
                    mtime: entry.mtime,
                    size: entry.size,
                    ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
                    ...(entry.etag ? { etag: entry.etag } : {}),
                };
                sides.set(path, { entry: revived, object });
                headQueue.add(path);
            } else {
                staleObjects.push(object);
                sides.set(path, { entry });
            }
            continue;
        }
        if (entry && object) {
            sides.set(path, { entry, object });
            const etagChanged = Boolean(
                entry.etag && object.etag && object.etag !== entry.etag,
            );
            if (etagChanged || object.size !== entry.size || !entry.sha256) {
                headQueue.add(path);
            }
            continue;
        }
        if (entry && !object) {
            headQueue.add(path);
            continue;
        }
        if (!entry && object) {
            sides.set(path, { object });
            // Remote-only objects use GET metadata; HEAD only with a local copy.
            if (localPaths.has(path)) headQueue.add(path);
        }
    }

    const refreshedManifest = new Map<string, ManifestEntry>();
    const unknownPaths = new Set<string>();
    const headTotal = headQueue.size;
    let headDone = 0;
    if (headTotal > 0) onStatus?.("verifying remote files");

    await forEachPool(headQueue, HEAD_POOL, async (path) => {
        if (isCanceled?.()) return;
        headDone++;
        if (headDone % 100 === 0) {
            onStatus?.(`verifying remote files: ${headDone}/${headTotal}`);
        }
        let head;
        try {
            head = await client.headObject(`${prefixWithSlash}${path}`);
        } catch (error) {
            unknownPaths.add(path);
            warnings.push(
                `Unable to verify ${path}; leaving it untouched: ${errorText(error)}`,
            );
            return;
        }
        const manifestEntry = manifest.files[path];
        if (!head) {
            if (manifestEntry?.deleted) {
                sides.set(path, { entry: manifestEntry });
            } else {
                sides.delete(path);
            }
            objects.delete(path);
            return;
        }
        const existing = sides.get(path);
        const existingObject = objects.get(path);
        const baseEntry = existing?.entry && !existing.entry.deleted
            ? existing.entry
            : manifestEntry && !manifestEntry.deleted
                ? manifestEntry
                : undefined;
        const contentChanged = Boolean(
            baseEntry && (
                (head.etag && baseEntry.etag && head.etag !== baseEntry.etag)
                || head.size !== baseEntry.size
            ),
        );
        const nextMtime = head.mtime
            ?? (contentChanged
                ? head.lastModified || undefined
                : baseEntry?.mtime);
        const updated: RemoteObject = {
            path,
            size: head.size,
            etag: head.etag
                || existingObject?.etag
                || (contentChanged ? "" : baseEntry?.etag)
                || "",
            lastModified: head.lastModified || existingObject?.lastModified || 0,
            mtime: nextMtime,
            sha256: head.sha256,
        };
        objects.set(path, updated);
        if (baseEntry) {
            const refreshed: ManifestEntry = {
                ...baseEntry,
                mtime: updated.mtime ?? baseEntry.mtime,
                size: updated.size,
            };
            if (updated.etag) refreshed.etag = updated.etag;
            else delete refreshed.etag;
            if (head.sha256) refreshed.sha256 = head.sha256;
            else if (contentChanged) delete refreshed.sha256;
            sides.set(path, { entry: refreshed, object: updated });
            refreshedManifest.set(path, refreshed);
        } else {
            sides.set(path, { object: updated });
        }
    }, isCanceled);

    return { sides, refreshedManifest, staleObjects, unknownPaths, warnings };
}
