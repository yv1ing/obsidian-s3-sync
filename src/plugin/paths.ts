import { normalizeVaultPath } from "../core/util";

function joinPath(...parts: string[]): string {
    return normalizeVaultPath(parts.join("/"));
}

export function pluginDirectory(
    manifest: { dir?: string; id: string },
    configDir: string,
): string {
    return joinPath(manifest.dir ?? `${configDir}/plugins/${manifest.id}`);
}

export function pluginDataPath(pluginDir: string): string {
    return joinPath(pluginDir, "data.json");
}

export function syncManifestPath(configDir: string, pluginId: string): string {
    return joinPath(configDir, `${pluginId}.json`);
}
