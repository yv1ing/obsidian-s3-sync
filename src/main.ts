import { Modal, Notice, Plugin } from "obsidian";
import type { App } from "obsidian";

import type { SyncResult } from "./core/types";
import { errorText, normalizePrefix, yieldToUI } from "./core/util";
import { pluginDataPath, pluginDirectory, syncManifestPath } from "./plugin/paths";
import { normalizeSettings, type S3SyncSettings } from "./plugin/settings";
import { S3SyncSettingTab } from "./plugin/settings-tab";
import { S3Client } from "./s3/client";
import { baselineKey, loadBaselineSummary, resetBaseline } from "./sync/baseline";
import { SyncEngine } from "./sync/engine";
import { compileExcludes } from "./sync/exclusions";
import { vaultIdentity } from "./sync/vault";

const STARTUP_SYNC_DELAY_MS = 500;

class ConfirmModal extends Modal {
    constructor(
        app: App,
        private readonly heading: string,
        private readonly message: string,
        private readonly confirmLabel: string,
        private readonly onConfirm: () => void,
    ) {
        super(app);
    }

    onOpen(): void {
        this.titleEl.setText(this.heading);
        this.contentEl.createEl("p", { text: this.message });
        const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
        const cancel = buttons.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());
        const confirm = buttons.createEl("button", {
            text: this.confirmLabel,
            cls: "mod-cta",
        });
        confirm.addEventListener("click", () => {
            this.close();
            this.onConfirm();
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

export default class S3SyncPlugin extends Plugin {
    settings!: S3SyncSettings;

    private activeSync: Promise<void> | null = null;
    private statusEl: HTMLElement | null = null;
    private saveTimer: number | null = null;
    private unloaded = false;

    async onload(): Promise<void> {
        let dataExists: boolean | null = null;
        try {
            dataExists = await this.app.vault.adapter.exists(this.dataJsonPath());
        } catch {}
        let raw: Partial<S3SyncSettings> | null = null;
        try {
            raw = (await this.loadData()) as Partial<S3SyncSettings> | null;
        } catch (error) {
            console.error("[S3 Sync] failed to load settings", error);
        }
        if (dataExists === true && !raw) {
            console.error("[S3 Sync] data.json exists but could not be read; leaving it untouched");
            new Notice("S3 Sync: could not read data.json; settings left unchanged", 10000);
        }
        this.settings = normalizeSettings(raw, this.app.vault.getName());
        const hasSettingsFile = dataExists === true;

        this.addSettingTab(new S3SyncSettingTab(this.app, this));
        this.addRibbonIcon("refresh-cw", "S3 Sync: sync now", () => {
            void this.syncNow("ribbon");
        });
        this.addCommand({
            id: "sync-now",
            name: "Sync now",
            callback: () => {
                void this.syncNow("command");
            },
        });
        this.addCommand({
            id: "test-connection",
            name: "Test S3 connection",
            callback: () => {
                void this.testConnection();
            },
        });
        this.addCommand({
            id: "reset-sync-state",
            name: "Reset local sync state",
            callback: () => {
                this.confirmResetState();
            },
        });

        this.statusEl = this.addStatusBarItem();
        this.setStatus("idle");
        this.app.workspace.onLayoutReady(() => {
            if (this.unloaded || !hasSettingsFile) return;
            if (!this.settings.syncOnStartup) return;
            if (this.missingFields().length > 0) return;
            window.setTimeout(() => {
                if (this.unloaded) return;
                void this.syncNow("startup");
            }, STARTUP_SYNC_DELAY_MS);
        });
    }

    onunload(): void {
        this.unloaded = true;
        void this.flushSave();
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    scheduleSave(): void {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
        }
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.saveSettings().catch((error) => {
                console.error("[S3 Sync] failed to save settings", error);
            });
        }, 750);
    }

    async flushSave(): Promise<void> {
        if (this.saveTimer === null) return;
        window.clearTimeout(this.saveTimer);
        this.saveTimer = null;
        try {
            await this.saveSettings();
        } catch (error) {
            console.error("[S3 Sync] failed to save settings", error);
        }
    }

    dataJsonPath(): string {
        return pluginDataPath(this.runtimeDirectory());
    }

    async testConnection(): Promise<void> {
        const client = this.buildClient();
        if (!client) return;
        try {
            await client.testConnection();
            new Notice("S3 Sync: connection successful");
        } catch (error) {
            new Notice(`S3 Sync: connection failed: ${errorText(error)}`, 10000);
        }
    }

    async syncNow(reason = "manual"): Promise<void> {
        if (this.unloaded) return;
        if (this.activeSync) {
            new Notice("S3 Sync: sync already in progress");
            return;
        }
        const task = (async () => {
            try {
                await this.runSync();
            } catch (error) {
                if (this.unloaded) return;
                console.error("[S3 Sync] sync failed", reason, error);
                this.setStatus("error");
                new Notice(`S3 Sync failed: ${errorText(error)}`, 12000);
            }
        })();
        this.activeSync = task;
        try {
            await task;
        } finally {
            if (this.activeSync === task) this.activeSync = null;
        }
    }

    confirmResetState(): void {
        if (this.activeSync) {
            new Notice("S3 Sync: wait for the current sync to finish");
            return;
        }
        if (!this.configured()) {
            new Notice("S3 Sync: configure the endpoint and bucket first");
            return;
        }
        new ConfirmModal(
            this.app,
            "Reset local sync state?",
            "This clears this device's sync baseline only. The bucket is not modified. " +
            "On the next sync, existing remote tombstones can still delete matching local files.",
            "Reset state",
            () => {
                void this.resetState();
            },
        ).open();
    }

    async getStateSummary(): Promise<string> {
        if (!this.configured()) return "Not configured.";
        try {
            const summary = await loadBaselineSummary(
                await this.currentBaselineKey(),
            );
            if (!summary) {
                return "No sync summary yet; it appears after the next sync.";
            }
            const last = summary.lastSyncAt
                ? new Date(summary.lastSyncAt).toLocaleString()
                : "never";
            const state = summary.initialized ? "initialized" : "not initialized";
            return `Device ${summary.deviceId.slice(0, 8)} · ${state} · last sync: ${last}`;
        } catch (error) {
            return `Unavailable: ${errorText(error)}`;
        }
    }

    private async runSync(): Promise<void> {
        this.setStatus("starting");
        await yieldToUI();
        const client = this.buildClient();
        if (!client) {
            this.setStatus("not configured");
            return;
        }
        const snapshot: S3SyncSettings = {
            ...this.settings,
            excludePatterns: [...this.settings.excludePatterns],
        };
        this.setStatus("scanning");
        let lastTick = 0;
        const engine = new SyncEngine({
            app: this.app,
            client,
            settings: snapshot,
            exclude: compileExcludes(snapshot.excludePatterns),
            manifestPath: syncManifestPath(
                this.app.vault.configDir,
                this.manifest.id,
            ),
            dataJsonPath: this.dataJsonPath(),
            onStatus: (text) => this.setStatus(text),
            onProgress: (done, total) => {
                const now = Date.now();
                if (done === total || now - lastTick > 200) {
                    lastTick = now;
                    this.setStatus(`${done}/${total}`);
                }
            },
            isCanceled: () => this.unloaded,
        });
        const result = await engine.run();
        if (this.unloaded) return;
        if (result.failed > 0) {
            this.setStatus(`partial: ${result.failed} failed`);
        } else {
            this.setStatus(`ok ${new Date().toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
            })}`);
        }
        this.reportResult(result);
    }

    private reportResult(result: SyncResult): void {
        const deleted = result.deletedLocal + result.deletedRemote;
        const summary =
            `${result.uploaded} uploaded, ${result.downloaded} downloaded, ` +
            `${deleted} deleted, ${result.adopted} matched`;
        let text = result.firstSync
            ? `S3 Sync first sync complete: ${summary}`
            : `S3 Sync complete: ${summary}`;
        if (result.failed > 0) text += `, ${result.failed} failed`;
        new Notice(text, result.failed > 0 ? 12000 : 6000);

        if (result.recovery) {
            new Notice(
                "S3 Sync: the remote manifest was missing; recovery mode merged both sides " +
                "without deleting local files.",
                12000,
            );
        }
        if (result.configFileUpdated) {
            new Notice(
                "S3 Sync: this plugin's settings file was updated remotely. " +
                "Restart Obsidian to apply the new settings.",
                12000,
            );
        }
        if (result.errors.length > 0) {
            const shown = result.errors.slice(0, 5).join("\n");
            const more = result.errors.length > 5
                ? `\n...and ${result.errors.length - 5} more`
                : "";
            new Notice(`S3 Sync errors:\n${shown}${more}`, 15000);
        }
        if (result.warnings.length > 0) {
            const shown = result.warnings.slice(0, 3).join("\n");
            const more = result.warnings.length > 3
                ? `\n...and ${result.warnings.length - 3} more`
                : "";
            new Notice(`S3 Sync warnings:\n${shown}${more}`, 12000);
        }
    }

    private setStatus(text: string): void {
        this.statusEl?.setText(`S3 Sync: ${text}`);
    }

    private configured(): boolean {
        return Boolean(
            this.settings.endpoint.trim() && this.settings.bucket.trim(),
        );
    }

    private missingFields(): string[] {
        const missing: string[] = [];
        if (!this.settings.endpoint.trim()) missing.push("endpoint");
        if (!this.settings.bucket.trim()) missing.push("bucket");
        if (!this.settings.region.trim()) missing.push("region");
        if (!this.settings.accessKeyId.trim()) missing.push("access key ID");
        if (!this.settings.secretAccessKey.trim()) missing.push("secret access key");
        return missing;
    }

    private runtimeDirectory(): string {
        return pluginDirectory(this.manifest, this.app.vault.configDir);
    }

    private async currentBaselineKey(): Promise<string> {
        return baselineKey(
            this.settings.endpoint,
            this.settings.bucket,
            normalizePrefix(
                this.settings.prefix,
                this.app.vault.getName().trim() || "vault",
            ),
            vaultIdentity(this.app),
        );
    }

    private async resetState(): Promise<void> {
        try {
            await resetBaseline(await this.currentBaselineKey());
            new Notice(
                "S3 Sync: local sync state reset. The next sync will merge both sides.",
            );
        } catch (error) {
            new Notice(`S3 Sync: reset failed: ${errorText(error)}`);
        }
    }

    private buildClient(): S3Client | null {
        const missing = this.missingFields();
        if (missing.length > 0) {
            new Notice(`S3 Sync: missing ${missing.join(", ")}`);
            return null;
        }
        try {
            return new S3Client({
                endpoint: this.settings.endpoint,
                bucket: this.settings.bucket,
                region: this.settings.region,
                accessKeyId: this.settings.accessKeyId,
                secretAccessKey: this.settings.secretAccessKey,
                prefix: normalizePrefix(
                    this.settings.prefix,
                    this.app.vault.getName().trim() || "vault",
                ),
                isCanceled: () => this.unloaded,
            });
        } catch (error) {
            new Notice(`S3 Sync: ${errorText(error)}`);
            return null;
        }
    }
}
