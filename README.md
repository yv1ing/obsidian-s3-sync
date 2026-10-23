# S3 Sync

S3 Sync keeps an Obsidian vault and an S3-compatible bucket in two-way sync. The whole
vault is included: notes, attachments, dotfiles, `.obsidian` and installed plugins. When a file differs on both sides, the newest modification time wins.

## Features

- Two-way sync of every vault file.
- Newest modification time wins; a tie goes to the local file.
- Deletions propagate in both directions.
- The first sync on a device merges both sides without deleting remote files.
- Identical content is detected by SHA-256 and written only once.
- Configurable remote prefix, defaulting to the vault name.
- Editable exclusion patterns, with `.git/` and `.trash/` skipped by default.
- File modification times are preserved on write.
- Sync on startup (optional) and on demand.
- Status bar, ribbon icon and command-palette actions.
- No runtime dependencies and no AWS SDK. Works on desktop and mobile.

## Installation

Copy `main.js`, `manifest.json` and `styles.css` into:

```text
<vault>/.obsidian/plugins/s3-sync/
```

Enable **S3 Sync** under **Settings → Community plugins**.

## Settings

| Setting | Description |
| --- | --- |
| Endpoint | S3-compatible endpoint URL. |
| Bucket | Bucket name. |
| Region | Signing region. Required; use `auto` for Cloudflare R2. |
| Access key ID | S3 access key. |
| Secret access key | S3 secret key. |
| Remote prefix | Prefix for all objects. Defaults to the vault name. |
| Exclude patterns | One glob per line. Defaults to `.git/` and `.trash/`. |
| Sync on startup | Run a sync after Obsidian starts. |

Endpoint, bucket, region, access key ID and secret access key are required. The bucket
must already exist. After configuring, run **Sync now** once; enable **Sync on startup**
to sync on later launches.

## Remote layout

```text
<prefix>/<vault-relative-path>
<prefix>/.obsidian/s3-sync.json
```

The sync manifest lives at `.obsidian/s3-sync.json` in the vault and at the same
path under the remote prefix. The plugin keeps this single manifest in sync between
the two and reserves the path from regular file syncing.

## Exclusions

Patterns match vault-relative paths with forward slashes. `*` matches within one path
segment, `**` crosses segments, and `?` matches one character. A leading `/` anchors a
pattern at the vault root; a trailing `/` covers a whole directory tree.

| Pattern | Matches |
| --- | --- |
| `.git/` | any `.git` directory and its contents |
| `.trash/` | any `.trash` directory and its contents |
| `*.tmp` | any `.tmp` file at any depth |
| `/private/` | only the top-level `private` directory |
| `**/cache/` | any `cache` directory at any depth |
| `notes/?-draft.md` | `notes/a-draft.md`, but not `notes/ab-draft.md` |

## Addressing

S3 providers put the bucket in different parts of the request URL. If the endpoint host
is the bucket name or starts with the bucket name and a dot, S3 Sync uses virtual-hosted
requests. Otherwise it uses path-style requests.

```text
Path-style:      https://s3.example.com/<bucket>/<key>
Virtual-hosted:  https://<bucket>.s3.example.com/<key>
```

If a provider only accepts virtual-hosted requests, add the bucket to the endpoint host.

### Provider examples

```text
AWS S3
Endpoint:   https://s3.us-east-1.amazonaws.com
Region:     us-east-1
# or virtual-hosted: https://<bucket>.s3.us-east-1.amazonaws.com

Cloudflare R2
Endpoint:   https://<account>.r2.cloudflarestorage.com
Region:     auto

Aliyun OSS
Endpoint:   https://<bucket>.s3.oss-cn-hangzhou.aliyuncs.com
Region:     cn-hangzhou

MinIO
Endpoint:   http://localhost:9000
Region:     us-east-1
```

## License

MIT
