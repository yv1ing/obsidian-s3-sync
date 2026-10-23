import type { App, DataAdapter } from "obsidian";
import { FileSystemAdapter, Platform, TFile } from "obsidian";

import type { LocalFile } from "../core/types";
import {
    MTIME_TOLERANCE_MS,
    clampMtime,
    createLimiter,
    createYieldTicker,
    errorText,
    forEachPool,
    isSafeManifestPath,
    normalizeVaultPath,
    parentPaths,
    sha256Hex,
    toEpochMs,
} from "../core/util";

export interface VaultScanOptions {
    exclude: (path: string) => boolean;
    onProgress?: (directories: number, files: number) => void;
    isCanceled?: () => boolean;
}

export interface VaultContent {
    body: ArrayBuffer;
    sha256: string;
    size: number;
}

export interface VaultWriteResult {
    mtime: number;
    size: number;
    sha256: string;
    mtimeExact: boolean;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const INVALID_SEGMENT_CHARS = /[\u0000-\u001f\u007f<>:"|?*]/;
const STAT_POOL = 8;
const DIRECTORY_POOL = 4;

interface NodeFsPromises {
    realpath?: (path: string) => Promise<string>;
    utimes?: (path: string, atime: Date, mtime: Date) => Promise<void>;
}

let cachedFsPromises: NodeFsPromises | null | undefined;

function desktopFsPromises(): NodeFsPromises | null {
    if (!Platform.isDesktopApp) return null;
    if (cachedFsPromises !== undefined) return cachedFsPromises;
    try {
        const nodeRequire = (
            window as unknown as { require?: (name: string) => unknown }
        ).require;
        const fs = nodeRequire?.("fs") as {
            promises?: NodeFsPromises;
        } | undefined;
        cachedFsPromises = fs?.promises ?? null;
    } catch {
        cachedFsPromises = null;
    }
    return cachedFsPromises;
}

async function realDirectoryPath(
    app: App,
    relative: string,
): Promise<string | null> {
    const adapter = app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    const realpath = desktopFsPromises()?.realpath;
    if (!realpath) return null;
    try {
        return await realpath(`${adapter.getBasePath()}/${relative}`);
    } catch {
        return null;
    }
}

export async function scanVault(
    app: App,
    options: VaultScanOptions,
): Promise<Map<string, LocalFile>> {
    const adapter = app.vault.adapter;
    const paths: string[] = [];
    const visited = new Set<string>();
    const realVisited = new Set<string>();
    const directorySlots = createLimiter(DIRECTORY_POOL);
    const tick = createYieldTicker();
    let rootFolders: string[] = [];
    let directories = 0;
    let failed = false;
    const canceled = (): boolean => options.isCanceled?.() === true;

    const walk = async (directory: string): Promise<void> => {
        if (failed || canceled()) return;
        const normalizedDirectory = normalizeVaultPath(directory);
        if (normalizedDirectory) {
            if (visited.has(normalizedDirectory)) return;
            visited.add(normalizedDirectory);
        }

        let listed: { files: string[]; folders: string[] } | null = null;
        await directorySlots.acquire(1);
        try {
            if (failed || canceled()) return;
            const real = await realDirectoryPath(app, normalizedDirectory);
            if (real) {
                if (realVisited.has(real)) return;
                realVisited.add(real);
            }
            try {
                listed = await adapter.list(directory);
            } catch (error) {
                failed = true;
                throw new Error(
                    `Unable to list ${directory || "/"}: ${errorText(error)}`,
                );
            }
        } finally {
            directorySlots.release(1);
        }
        if (!listed || failed || canceled()) return;

        directories++;
        if (!normalizedDirectory) {
            rootFolders = listed.folders.map((folder) => normalizeVaultPath(folder));
        }
        for (const file of listed.files) {
            const pause = tick();
            if (pause) {
                await pause;
                if (failed || canceled()) return;
            }
            const relative = normalizeVaultPath(file);
            if (!relative || options.exclude(relative)) continue;
            paths.push(relative);
        }
        options.onProgress?.(directories, paths.length);

        const subfolders = listed.folders
            .map((folder) => ({
                original: folder,
                relative: normalizeVaultPath(folder),
            }))
            .filter(({ relative }) =>
                relative && !options.exclude(relative) && !visited.has(relative));
        await forEachPool(
            subfolders,
            DIRECTORY_POOL,
            ({ original }) => walk(original),
            () => failed || canceled(),
        );
    };

    try {
        await walk("");
    } catch (error) {
        failed = true;
        throw error;
    }

    if (canceled()) return new Map();

    const configDir = normalizeVaultPath(app.vault.configDir);
    if (configDir && !options.exclude(configDir)) {
        const seen = rootFolders.some(
            (folder) => folder.toLowerCase() === configDir.toLowerCase(),
        );
        if (!seen) {
            let configExists = false;
            try {
                configExists = await adapter.exists(configDir);
            } catch {
                configExists = false;
            }
            if (configExists) {
                throw new Error(
                    `Vault enumeration did not include ${configDir}; ` +
                    "refusing to sync without the Obsidian configuration directory",
                );
            }
        }
    }

    const files = new Map<string, LocalFile>();
    try {
        await forEachPool(
            paths,
            STAT_POOL,
            async (path) => {
                try {
                    const stat = await adapter.stat(path);
                    if (!stat) {
                        if (await adapter.exists(path)) {
                            throw new Error(`Unable to read file metadata for ${path}`);
                        }
                        return;
                    }
                    if (stat.type !== "file") return;
                    files.set(path, {
                        mtime: toEpochMs(stat.mtime) ?? Date.now(),
                        size: stat.size,
                    });
                } catch (error) {
                    failed = true;
                    throw error;
                }
            },
            () => failed || canceled(),
        );
    } catch (error) {
        failed = true;
        throw error;
    }
    return files;
}

export async function readVaultFile(app: App, path: string): Promise<VaultContent> {
    const body = await app.vault.adapter.readBinary(path);
    return {
        body,
        sha256: await sha256Hex(body),
        size: body.byteLength,
    };
}

export async function hashVaultFile(app: App, path: string): Promise<string> {
    return sha256Hex(await app.vault.adapter.readBinary(path));
}

export async function writeVaultFile(
    app: App,
    path: string,
    body: ArrayBuffer,
    expectedSha256: string | undefined,
    remoteMtime: number,
): Promise<VaultWriteResult> {
    const actualSha256 = await sha256Hex(body);
    if (expectedSha256 && actualSha256 !== expectedSha256) {
        throw new Error(`Checksum mismatch while downloading ${path}`);
    }
    const adapter = app.vault.adapter;
    const normalized = normalizeVaultPath(path);
    await ensureParents(adapter, normalized);
    const stamp = clampMtime(remoteMtime);
    try {
        await adapter.writeBinary(normalized, body, { mtime: stamp, ctime: stamp });
    } catch {
        await adapter.writeBinary(normalized, body);
    }
    await restoreDesktopMtime(app, normalized, stamp);
    const stat = await adapter.stat(normalized);
    if (!stat) throw new Error(`File was not created: ${normalized}`);
    const mtime = toEpochMs(stat.mtime) ?? stamp;
    return {
        mtime,
        size: stat.size,
        sha256: actualSha256,
        mtimeExact: Math.abs(mtime - stamp) <= MTIME_TOLERANCE_MS,
    };
}

export async function deleteVaultFile(app: App, path: string): Promise<void> {
    const adapter = app.vault.adapter;
    try {
        if (await adapter.exists(path)) await adapter.remove(path);
    } catch (error) {
        if (await adapter.exists(path)) {
            throw new Error(`Unable to delete ${path}: ${errorText(error)}`);
        }
    }
}

export async function setVaultMtime(app: App, path: string, mtime: number): Promise<void> {
    await restoreDesktopMtime(app, path, mtime);
}

export function notifyVault(
    app: App,
    path: string,
    kind: "create" | "modify" | "delete",
): void {
    try {
        const file = app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) app.vault.trigger(kind, file);
    } catch {}
}

export function vaultIdentity(app: App): string {
    const name = app.vault.getName();
    const adapter = app.vault.adapter;
    if (Platform.isDesktopApp && adapter instanceof FileSystemAdapter) {
        return `${name}\n${adapter.getBasePath()}`;
    }
    return name;
}

export function sanitizeRemotePath(
    remotePath: string,
    reservedPath: string,
): string | null {
    const path = remotePath.replace(/\/+$/, "");
    if (!isSafeManifestPath(path)) return null;
    if (path.toLowerCase() === reservedPath.toLowerCase()) return null;
    if (/^[a-zA-Z]:/.test(path)) return null;
    for (const segment of path.split("/")) {
        if (INVALID_SEGMENT_CHARS.test(segment)) return null;
        if (/[. ]$/.test(segment)) return null;
        if (WINDOWS_RESERVED.test(segment)) return null;
    }
    return path;
}

async function ensureParents(adapter: DataAdapter, path: string): Promise<void> {
    for (const parent of parentPaths(path)) {
        if (await adapter.exists(parent)) continue;
        try {
            await adapter.mkdir(parent);
        } catch (error) {
            if (!(await adapter.exists(parent))) {
                throw new Error(`Unable to create ${parent}: ${errorText(error)}`);
            }
        }
    }
}

async function restoreDesktopMtime(
    app: App,
    path: string,
    mtime: number,
): Promise<void> {
    if (!Platform.isDesktopApp) return;
    const adapter = app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    try {
        const stat = await adapter.stat(path);
        if (stat && Math.abs((toEpochMs(stat.mtime) ?? 0) - mtime) < 1000) return;
        const utimes = desktopFsPromises()?.utimes;
        if (!utimes) return;
        const fullPath = `${adapter.getBasePath()}/${path}`;
        const date = new Date(mtime);
        await utimes(fullPath, date, date);
    } catch {}
}
