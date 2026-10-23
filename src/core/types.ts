export interface ManifestEntry {
    mtime: number;
    size: number;
    sha256?: string;
    etag?: string;
    deleted?: boolean;
    deletedAt?: number;
}

export interface Manifest {
    schema: 1;
    app: "obsidian-s3-sync";
    prefix: string;
    vault: string;
    deviceId: string;
    updatedAt: number;
    files: Record<string, ManifestEntry>;
}

export interface BaselineEntry {
    mtime: number;
    size: number;
    sha256?: string;
    etag?: string;
    /** False when the platform ignored the requested modification time. */
    mtimeExact?: boolean;
}

export interface Baseline {
    schema: 1;
    key: string;
    deviceId: string;
    vault: string;
    initialized: boolean;
    lastSyncAt: number;
    conditionalPutUnsupported: boolean;
    entries: Record<string, BaselineEntry>;
}

export interface LocalFile {
    mtime: number;
    size: number;
}

export interface LocalSide extends LocalFile {
    sha256?: string;
}

export interface RemoteObject {
    path: string;
    size: number;
    etag: string;
    lastModified: number;
    mtime?: number;
    sha256?: string;
}

export interface RemoteSide {
    entry?: ManifestEntry;
    object?: RemoteObject;
}

export type ActionKind =
    | "none"
    | "upload"
    | "download"
    | "deleteLocal"
    | "deleteRemote"
    | "adopt";

export interface PlannedAction {
    path: string;
    kind: ActionKind;
    remote?: RemoteObject;
    adoptMtime?: number;
}

export interface SyncResult {
    uploaded: number;
    downloaded: number;
    deletedLocal: number;
    deletedRemote: number;
    adopted: number;
    failed: number;
    scanned: number;
    errors: string[];
    warnings: string[];
    firstSync: boolean;
    recovery: boolean;
    configFileUpdated: boolean;
    durationMs: number;
}
