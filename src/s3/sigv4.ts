import { amzDate, hmacSha256, rfc3986, sha256Hex, toHex } from "../core/util";

export interface SignOptions {
    method: string;
    path: string;
    query?: Record<string, string | undefined>;
    headers: Record<string, string>;
    payloadHash: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    service?: string;
    signingKey?: Uint8Array;
}

export interface SignedRequest {
    authorization: string;
    canonicalRequest: string;
    stringToSign: string;
    signature: string;
    date: string;
    signedHeaders: string;
}

export function canonicalQuery(query: Record<string, string | undefined> = {}): string {
    const pairs: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(query)) {
        if (value === undefined) continue;
        pairs.push([rfc3986(name), rfc3986(String(value))]);
    }
    pairs.sort((left, right) => {
        if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
        if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
        return 0;
    });
    return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

function canonicalHeaders(headers: Record<string, string>): {
    canonical: string;
    signed: string;
} {
    const normalized = Object.entries(headers)
        .map(([name, value]) => [
            name.trim().toLowerCase(),
            value.trim().replace(/\s+/g, " "),
        ] as [string, string])
        .filter(([name]) => name !== "content-length" && name !== "authorization")
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return {
        canonical: normalized.map(([name, value]) => `${name}:${value}\n`).join(""),
        signed: normalized.map(([name]) => name).join(";"),
    };
}

export async function deriveSigningKey(
    secretAccessKey: string,
    day: string,
    region: string,
    service: string,
): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const dateKey = await hmacSha256(encoder.encode(`AWS4${secretAccessKey}`), day);
    const regionKey = await hmacSha256(dateKey, region);
    const serviceKey = await hmacSha256(regionKey, service);
    return hmacSha256(serviceKey, "aws4_request");
}

export async function signRequest(options: SignOptions): Promise<SignedRequest> {
    const service = options.service ?? "s3";
    const date = options.headers["x-amz-date"] ?? amzDate();
    const day = date.slice(0, 8);
    const scope = `${day}/${options.region}/${service}/aws4_request`;
    const query = canonicalQuery(options.query);
    const { canonical, signed } = canonicalHeaders(options.headers);
    const canonicalRequest = [
        options.method,
        options.path,
        query,
        canonical,
        signed,
        options.payloadHash,
    ].join("\n");
    const stringToSign = [
        "AWS4-HMAC-SHA256",
        date,
        scope,
        await sha256Hex(canonicalRequest),
    ].join("\n");
    const key = options.signingKey ?? await deriveSigningKey(
        options.secretAccessKey,
        day,
        options.region,
        service,
    );
    const signature = toHex(await hmacSha256(key, stringToSign));
    const authorization =
        `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signed}, Signature=${signature}`;
    return {
        authorization,
        canonicalRequest,
        stringToSign,
        signature,
        date,
        signedHeaders: signed,
    };
}
