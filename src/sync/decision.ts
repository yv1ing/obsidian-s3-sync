import type {
    ActionKind,
    BaselineEntry,
    LocalSide,
    PlannedAction,
    RemoteSide,
} from "../core/types";
import { sideEtag, sideMtime, sideSha256, sideSize } from "../core/util";

type LocalKind = "same" | "changed" | "new" | "gone";
type RemoteKind = "same" | "changed" | "tomb" | "none";

function classifyLocal(
    local: LocalSide | undefined,
    baseline: BaselineEntry | undefined,
): LocalKind {
    if (!local) return "gone";
    if (!baseline) return "new";
    if (local.mtime === baseline.mtime && local.size === baseline.size) {
        return "same";
    }
    if (
        local.size === baseline.size
        && local.sha256
        && baseline.sha256
        && local.sha256 === baseline.sha256
    ) {
        return "same";
    }
    return "changed";
}

function classifyRemote(
    remote: RemoteSide | undefined,
    baseline: BaselineEntry | undefined,
): RemoteKind {
    if (!remote) return "none";
    if (remote.entry?.deleted) return "tomb";
    if (!remote.object && !remote.entry) return "none";
    if (!baseline) return "changed";
    const size = sideSize(remote);
    const sha256 = sideSha256(remote);
    if (sha256 && baseline.sha256) {
        return sha256 === baseline.sha256 && size === baseline.size ? "same" : "changed";
    }
    const etag = sideEtag(remote);
    if (etag && baseline.etag && etag === baseline.etag && size === baseline.size) {
        return "same";
    }
    const mtime = sideMtime(remote);
    if (mtime > 0 && mtime === baseline.mtime && size === baseline.size) {
        return "same";
    }
    return "changed";
}

export interface DecideInput {
    path: string;
    local?: LocalSide;
    remote?: RemoteSide;
    baseline?: BaselineEntry;
    initialized: boolean;
}

export function decide(input: DecideInput): PlannedAction {
    const baseline = input.initialized ? input.baseline : undefined;
    const local = input.local;
    const side = input.remote;
    const localKind = classifyLocal(local, baseline);
    const remoteKind = classifyRemote(side, baseline);
    const action = (
        kind: ActionKind,
        extra: Omit<PlannedAction, "path" | "kind"> = {},
    ): PlannedAction => ({ path: input.path, kind, ...extra });
    const tombstone = side?.entry?.deleted ? side.entry : undefined;
    const live = side && !side.entry?.deleted ? side : undefined;

    if (tombstone) {
        const deletedAt = tombstone.deletedAt ?? tombstone.mtime ?? 0;
        if (!local) return action("none");
        return local.mtime >= deletedAt ? action("upload") : action("deleteLocal");
    }

    if (!local) {
        if (!live) {
            return baseline ? action("deleteRemote") : action("none");
        }
        if (baseline) {
            const remoteMtime = sideMtime(live);
            if (remoteKind !== "same" && remoteMtime > baseline.mtime) {
                return action("download", { remote: live.object });
            }
            return action("deleteRemote");
        }
        return action("download", { remote: live.object });
    }

    if (!live) return action("upload");

    const remoteMtime = sideMtime(live);
    const remoteSha256 = sideSha256(live);
    const remoteSize = sideSize(live);

    if (localKind === "same") {
        if (remoteKind === "same") return action("none");
        return action("download", { remote: live.object });
    }
    if (remoteKind === "same") return action("upload");
    if (
        local.sha256
        && remoteSha256
        && local.sha256 === remoteSha256
        && local.size === remoteSize
    ) {
        return action("adopt", {
            adoptMtime: Math.max(local.mtime, remoteMtime),
        });
    }
    return local.mtime >= remoteMtime
        ? action("upload")
        : action("download", { remote: live.object });
}
