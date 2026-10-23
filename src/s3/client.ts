import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";

import {
    EMPTY_SHA256,
    amzDate,
    encodeKey,
    errorText,
    normalizePrefix,
    normalizeSha256,
    quoteEtag,
    rfc3986,
    sha256Hex,
    stripQuotes,
    toEpochMs,
} from "../core/util";
import { canonicalQuery, deriveSigningKey, signRequest } from "./sigv4";

export interface S3ClientConfig {
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
    isCanceled?: () => boolean;
}

export interface S3ListEntry {
    key: string;
    etag: string;
    size: number;
    lastModified: number;
}

export interface S3Head {
    etag: string;
    size: number;
    lastModified: number;
    mtime?: number;
    sha256?: string;
}

export interface S3Object extends S3Head {
    body: ArrayBuffer;
}

export interface PutOptions {
    contentType?: string;
    mtime: number;
    sha256: string;
    ifMatch?: string;
    ifNoneMatch?: string;
}

export class S3Error extends Error {
    readonly status: number;
    readonly code?: string;

    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = "S3Error";
        this.status = status;
        this.code = code;
    }
}

const MAX_ATTEMPTS = 4;
const READ_TIMEOUT = 60_000;
const WRITE_TIMEOUT = 120_000;

export class S3Client {
    private readonly origin: string;
    private readonly host: string;
    private readonly objectPath: string;
    private readonly region: string;
    private readonly accessKeyId: string;
    private readonly secretAccessKey: string;
    private readonly isCanceled?: () => boolean;
    readonly prefix: string;
    private signingKeyDay = "";
    private signingKeyValue: Uint8Array | null = null;

    constructor(config: S3ClientConfig) {
        const endpoint = config.endpoint.trim();
        const bucket = config.bucket.trim();
        const region = config.region.trim();
        this.accessKeyId = config.accessKeyId.trim();
        this.secretAccessKey = config.secretAccessKey.trim();
        this.isCanceled = config.isCanceled;
        this.prefix = normalizePrefix(config.prefix, "vault");
        if (!endpoint || !bucket || !region || !this.accessKeyId || !this.secretAccessKey) {
            throw new Error(
                "Endpoint, bucket, region, access key ID and secret access key are required",
            );
        }
        const url = new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`);
        const basePath = url.pathname.replace(/\/+$/, "");
        const virtualHosted = url.hostname === bucket || url.hostname.startsWith(`${bucket}.`);
        this.host = url.host;
        this.origin = `${url.protocol}//${this.host}`;
        const lastSegment = basePath.split("/").pop();
        const bucketInPath = lastSegment === bucket || lastSegment === rfc3986(bucket);
        this.objectPath = virtualHosted || bucketInPath
            ? basePath
            : `${basePath}/${rfc3986(bucket)}`;
        this.region = region;
    }

    async testConnection(): Promise<void> {
        await this.listObjects(`${this.prefix}/`, { maxKeys: 1, maxPages: 1 });
    }

    async listObjects(
        prefix: string,
        options: {
            maxKeys?: number;
            maxPages?: number;
            shouldStop?: () => boolean;
        } = {},
        onEntry?: (entry: S3ListEntry) => void,
    ): Promise<void> {
        const seen = new Set<string>();
        let token: string | undefined;
        let emptyPages = 0;
        const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
        for (let page = 0; page < maxPages; page++) {
            if (options.shouldStop?.()) break;
            const query: Record<string, string | undefined> = {
                "list-type": "2",
                "max-keys": String(options.maxKeys ?? 1000),
            };
            if (prefix) query.prefix = prefix;
            if (token) query["continuation-token"] = token;
            const response = await this.request(
                "GET",
                this.bucketPath(),
                query,
                undefined,
                {},
                READ_TIMEOUT,
                false,
            );
            const xml = this.parseXml(response.text);
            let pageCount = 0;
            for (const contents of this.elements(xml, "Contents")) {
                if (options.shouldStop?.()) break;
                const key = this.elements(contents, "Key")[0]?.textContent ?? "";
                if (!key) continue;
                pageCount++;
                const entry: S3ListEntry = {
                    key,
                    etag: stripQuotes(this.firstText(contents, "ETag")),
                    size: Number(this.firstText(contents, "Size")) || 0,
                    lastModified: toEpochMs(this.firstText(contents, "LastModified")) ?? 0,
                };
                onEntry?.(entry);
            }
            if (options.shouldStop?.()) break;
            if (this.firstText(xml, "IsTruncated") !== "true") break;
            if (pageCount === 0) {
                emptyPages++;
                if (emptyPages >= 3) break;
            } else {
                emptyPages = 0;
            }
            const next = this.firstText(xml, "NextContinuationToken");
            if (!next || seen.has(next)) break;
            seen.add(next);
            token = next;
        }
    }

    async headObject(key: string): Promise<S3Head | null> {
        const response = await this.request(
            "HEAD",
            this.pathFor(key),
            {},
            undefined,
            {},
            READ_TIMEOUT,
            true,
        );
        if (response.status === 404) return null;
        return {
            etag: stripQuotes(this.header(response.headers, "etag") ?? ""),
            size: Number(this.header(response.headers, "content-length") ?? 0) || 0,
            lastModified: toEpochMs(this.header(response.headers, "last-modified")) ?? 0,
            mtime: toEpochMs(this.header(response.headers, "x-amz-meta-mtime")),
            sha256: normalizeSha256(
                this.header(response.headers, "x-amz-meta-sha256"),
            ),
        };
    }

    async getObject(key: string): Promise<S3Object | null> {
        const response = await this.request(
            "GET",
            this.pathFor(key),
            {},
            undefined,
            {},
            WRITE_TIMEOUT,
            true,
        );
        if (response.status === 404) return null;
        const body = response.arrayBuffer;
        return {
            body,
            etag: stripQuotes(this.header(response.headers, "etag") ?? ""),
            size: Number(this.header(response.headers, "content-length") ?? body.byteLength)
                || body.byteLength,
            lastModified: toEpochMs(this.header(response.headers, "last-modified")) ?? 0,
            mtime: toEpochMs(this.header(response.headers, "x-amz-meta-mtime")),
            sha256: normalizeSha256(
                this.header(response.headers, "x-amz-meta-sha256"),
            ),
        };
    }

    async putObject(
        key: string,
        body: ArrayBuffer,
        options: PutOptions,
    ): Promise<{ etag: string }> {
        const headers: Record<string, string> = {
            "x-amz-meta-mtime": String(Math.round(options.mtime)),
            "x-amz-meta-sha256": options.sha256,
        };
        if (options.contentType) headers["content-type"] = options.contentType;
        if (options.ifMatch) headers["if-match"] = quoteEtag(options.ifMatch);
        if (options.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;
        const response = await this.request(
            "PUT",
            this.pathFor(key),
            {},
            body,
            headers,
            WRITE_TIMEOUT,
            false,
            options.sha256,
        );
        return { etag: stripQuotes(this.header(response.headers, "etag") ?? "") };
    }

    async deleteObject(key: string): Promise<void> {
        await this.request(
            "DELETE",
            this.pathFor(key),
            {},
            undefined,
            {},
            READ_TIMEOUT,
            true,
        );
    }

    private bucketPath(): string {
        return this.objectPath || "/";
    }

    private pathFor(key: string): string {
        return `${this.objectPath}/${encodeKey(key)}`;
    }

    private async request(
        method: string,
        path: string,
        query: Record<string, string | undefined>,
        body: ArrayBuffer | undefined,
        extraHeaders: Record<string, string>,
        timeoutMs: number,
        allowNotFound: boolean,
        payloadHashOverride?: string,
    ): Promise<RequestUrlResponse> {
        const payloadHash = payloadHashOverride
            ?? (body ? await sha256Hex(body) : EMPTY_SHA256);
        let lastError: unknown;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            if (this.isCanceled?.()) {
                throw new S3Error("S3 request canceled", 0, "Canceled");
            }
            const date = amzDate();
            const headers: Record<string, string> = {
                "x-amz-content-sha256": payloadHash,
                "x-amz-date": date,
                ...extraHeaders,
            };
            const signingHeaders: Record<string, string> = { host: this.host };
            for (const [name, value] of Object.entries(headers)) {
                if (name.toLowerCase().startsWith("x-amz-")) {
                    signingHeaders[name] = value;
                }
            }
            const signed = await signRequest({
                method,
                path,
                query,
                headers: signingHeaders,
                payloadHash,
                accessKeyId: this.accessKeyId,
                secretAccessKey: this.secretAccessKey,
                region: this.region,
                signingKey: await this.signingKeyFor(date.slice(0, 8)),
            });
            const queryString = canonicalQuery(query);
            const url = `${this.origin}${path}${queryString ? `?${queryString}` : ""}`;
            try {
                const response = await this.withTimeout(
                    requestUrl({
                        url,
                        method,
                        headers: { ...headers, Authorization: signed.authorization },
                        body,
                        throw: false,
                    }),
                    timeoutMs,
                );
                if (allowNotFound && response.status === 404) return response;
                if (response.status >= 200 && response.status < 300) return response;
                const error = this.errorFor(response);
                if (this.isRetryable(response.status) && attempt < MAX_ATTEMPTS - 1) {
                    lastError = error;
                    await this.sleep(this.retryDelay(attempt, response.headers));
                    continue;
                }
                throw error;
            } catch (error) {
                if (error instanceof S3Error) throw error;
                lastError = error;
                if (attempt < MAX_ATTEMPTS - 1) {
                    await this.sleep(this.retryDelay(attempt));
                    continue;
                }
                throw new S3Error(`Network error: ${errorText(error)}`, 0);
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new S3Error("S3 request failed", 0);
    }

    private async signingKeyFor(day: string): Promise<Uint8Array> {
        if (this.signingKeyValue && this.signingKeyDay === day) {
            return this.signingKeyValue;
        }
        this.signingKeyValue = await deriveSigningKey(
            this.secretAccessKey,
            day,
            this.region,
            "s3",
        );
        this.signingKeyDay = day;
        return this.signingKeyValue;
    }

    private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        let timer = 0;
        const timeout = new Promise<never>((_, reject) => {
            timer = window.setTimeout(
                () => reject(new Error(`Request timed out after ${timeoutMs} ms`)),
                timeoutMs,
            );
        });
        try {
            return await Promise.race([promise, timeout]);
        } finally {
            window.clearTimeout(timer);
        }
    }

    private sleep(milliseconds: number): Promise<void> {
        return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    }

    private retryDelay(attempt: number, headers?: Record<string, string>): number {
        const retryAfter = headers ? this.header(headers, "retry-after") : undefined;
        if (retryAfter) {
            const seconds = Number(retryAfter);
            if (Number.isFinite(seconds) && seconds > 0) {
                return Math.min(30_000, seconds * 1000);
            }
            const parsed = Date.parse(retryAfter);
            if (Number.isFinite(parsed)) {
                return Math.min(30_000, Math.max(0, parsed - Date.now()));
            }
        }
        const base = Math.min(8000, 300 * 2 ** attempt);
        return base + Math.floor(Math.random() * 250);
    }

    private isRetryable(status: number): boolean {
        return status === 408 || status === 429 || (status >= 500 && status < 600);
    }

    private errorFor(response: RequestUrlResponse): S3Error {
        const text = response.text ?? "";
        const code = /<Code>([\s\S]*?)<\/Code>/.exec(text)?.[1];
        const message = /<Message>([\s\S]*?)<\/Message>/.exec(text)?.[1];
        const requestId = /<RequestId>([\s\S]*?)<\/RequestId>/.exec(text)?.[1];
        const detail = [code, message].filter(Boolean).join(": ")
            || text.slice(0, 300).trim();
        const suffix = requestId ? ` (request ${requestId})` : "";
        return new S3Error(
            `S3 ${response.status}${detail ? `: ${detail}` : ""}${suffix}`,
            response.status,
            code,
        );
    }

    private header(headers: Record<string, string>, name: string): string | undefined {
        const lower = name.toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === lower) return value;
        }
        return undefined;
    }

    private parseXml(text: string): Document {
        const xml = new DOMParser().parseFromString(text, "text/xml");
        if (xml.getElementsByTagName("parsererror").length > 0) {
            throw new S3Error("Invalid XML response from S3", 0);
        }
        return xml;
    }

    private elements(root: Document | Element, tag: string): Element[] {
        const direct = Array.from(root.getElementsByTagName(tag));
        return direct.length > 0
            ? direct
            : Array.from(root.getElementsByTagNameNS("*", tag));
    }

    private firstText(root: Document | Element, tag: string): string {
        return this.elements(root, tag)[0]?.textContent?.trim() ?? "";
    }
}
