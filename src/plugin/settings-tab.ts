import { Notice, PluginSettingTab, Setting } from "obsidian";
import type { App, Plugin } from "obsidian";

import { errorText } from "../core/util";
import type { S3SyncSettings } from "./settings";

type TextSettingKey =
    | "endpoint"
    | "bucket"
    | "region"
    | "accessKeyId"
    | "secretAccessKey"
    | "prefix";

export interface SettingsTabHost {
    settings: S3SyncSettings;
    dataJsonPath(): string;
    saveSettings(): Promise<void>;
    scheduleSave(): void;
    flushSave(): Promise<void>;
    testConnection(): Promise<void>;
    syncNow(reason?: string): Promise<void>;
    confirmResetState(): void;
    getStateSummary(): Promise<string>;
}

export class S3SyncSettingTab extends PluginSettingTab {
    private readonly host: SettingsTabHost;

    constructor(app: App, host: SettingsTabHost) {
        super(app, host as unknown as Plugin);
        this.host = host;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h3", { text: "Connection" });
        this.addText("Endpoint", "S3-compatible URL.", "endpoint");
        this.addText("Bucket", "Bucket name.", "bucket");
        this.addText("Region", "Required. Use auto for R2.", "region");
        this.addText("Access key ID", "S3 access key.", "accessKeyId");
        this.addText("Secret access key", "S3 secret key.", "secretAccessKey", true);

        new Setting(containerEl)
            .setName("Test connection")
            .setDesc("Read-only check.")
            .addButton((button) => button
                .setButtonText("Test")
                .setCta()
                .onClick(async () => {
                    button.setDisabled(true);
                    button.setButtonText("Testing...");
                    try {
                        await this.host.testConnection();
                    } finally {
                        button.setDisabled(false);
                        button.setButtonText("Test");
                    }
                }));

        containerEl.createEl("h3", { text: "Sync" });
        new Setting(containerEl)
            .setName("Remote prefix")
            .setDesc("Defaults to the vault name.")
            .addText((text) => {
                text.setValue(this.host.settings.prefix)
                    .onChange((value) => {
                        this.host.settings.prefix = value.replace(/^\/+|\/+$/g, "");
                        this.host.scheduleSave();
                    });
                text.inputEl.addClass("s3-sync-input");
            });

        new Setting(containerEl)
            .setName("Sync on startup")
            .setDesc("Run once after startup.")
            .addToggle((toggle) => toggle
                .setValue(this.host.settings.syncOnStartup)
                .onChange((value) => {
                    this.host.settings.syncOnStartup = value;
                    this.host.scheduleSave();
                }));

        new Setting(containerEl)
            .setName("Exclude patterns")
            .setDesc("One glob per line.")
            .addTextArea((area) => {
                area.setValue(this.host.settings.excludePatterns.join("\n"))
                    .onChange((value) => {
                        this.host.settings.excludePatterns = value
                            .split(/\r?\n/)
                            .map((line) => line.trim())
                            .filter(Boolean);
                        this.host.scheduleSave();
                    });
                area.inputEl.addClass("s3-sync-textarea");
                area.inputEl.rows = 4;
            });

        new Setting(containerEl)
            .setName("Sync now")
            .setDesc("Immediate sync.")
            .addButton((button) => button
                .setButtonText("Sync now")
                .onClick(() => {
                    void this.host.syncNow("settings");
                }));

        const state = new Setting(containerEl)
            .setName("Local sync state")
            .setDesc("On demand.")
            .addButton((button) => button
                .setButtonText("Show")
                .onClick(async () => {
                    button.setDisabled(true);
                    state.setDesc("Loading...");
                    try {
                        state.setDesc(await this.host.getStateSummary());
                    } finally {
                        button.setDisabled(false);
                    }
                }));

        containerEl.createEl("h3", { text: "Security" });
        new Setting(containerEl)
            .setName("Plugin credentials file")
            .setDesc("Stored in data.json.")
            .addButton((button) => button
                .setButtonText("Add exclusion")
                .onClick(async () => {
                    const path = this.host.dataJsonPath();
                    if (!this.host.settings.excludePatterns.includes(path)) {
                        this.host.settings.excludePatterns.push(path);
                        try {
                            await this.host.saveSettings();
                        } catch (error) {
                            new Notice(
                                `S3 Sync: unable to save settings: ${errorText(error)}`,
                            );
                            return;
                        }
                        this.display();
                        new Notice(`S3 Sync: added ${path} to exclusions`);
                    }
                }));

        new Setting(containerEl)
            .setName("Reset local sync state")
            .setDesc("Local baseline only.")
            .addButton((button) => button
                .setButtonText("Reset")
                .setWarning()
                .onClick(() => {
                    this.host.confirmResetState();
                }));
    }

    hide(): void {
        void this.host.flushSave();
    }

    private addText(
        name: string,
        description: string,
        key: TextSettingKey,
        secret = false,
    ): void {
        new Setting(this.containerEl)
            .setName(name)
            .setDesc(description)
            .addText((text) => {
                text.setValue(this.host.settings[key])
                    .onChange((value) => {
                        this.host.settings[key] = value;
                        this.host.scheduleSave();
                    });
                text.inputEl.addClass("s3-sync-input");
                if (secret) text.inputEl.type = "password";
            });
    }
}
