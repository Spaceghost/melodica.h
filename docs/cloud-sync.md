# Melodica library synchronization

The library is an append-only set of content-addressed MP3 payloads plus JSON,
artwork, and lyrics sidecars. Friendly `tracks/` paths and `by-music-id/`
entries are local symlinks and are rebuilt after a merge; they are not separate
audio copies.

## Data planes

The default data plane is peer-to-peer. An authenticated client announces an
opaque swarm identifier and an expiring endpoint to the Cloudflare tracker.
The tracker retains a five-minute lease, returns at most 64 live peers, and
does not expose GitHub names. A peer advertises only endpoints and protocol
capabilities it explicitly chooses to share.

A server-side capability can enable a second data plane. Those clients receive
short-lived S3 credentials and a wrapped, versioned crypt keyring. They use the
private `melodica-rclone` build to connect directly to Cloudflare R2; audio does
not pass through the Worker. The public tracker surface does not enumerate the
artifact or storage capability, and an unauthorized request receives the same
404 response as an unknown route.

## Rclone layout

Each crypt generation has its own encrypted prefix and rclone remote:

```text
melodica-s3:encrypted/v1  <- retired, readable
melodica-s3:encrypted/v2  <- retired, readable
melodica-s3:encrypted/v3  <- current, writable
```

Rotation creates a new password pair and prefix. Existing access and refresh
sessions stay valid; clients fetch the new wrapped keyring when its version
changes. Old prefixes remain readable until an owner runs a client-side copy
from the retired crypt remote to the current one. This is necessary because
rclone crypt keys cannot be changed in place without re-encrypting objects.

`melodica-sync --rclone melodica-v3` performs immutable, bidirectional copies
of `objects`, `metadata`, `artwork`, and `lyrics`, then verifies content hashes
and recreates the local aliases. It never mirrors the SQLite index or deletes
content during a merge.

## Private artifact build

The private rclone entry point imports only local, S3, and crypt backends and
the commands needed for immutable library synchronization. Release automation
must build Windows amd64/arm64, Linux amd64/arm64, macOS arm64, and Android
arm64 variants, sign a SHA-256 manifest, and place the binaries, GPLv3 license,
exact source revision, and corresponding-source offer in the capability-gated
artifact prefix.

The ordinary client package contains only the P2P connector. It does not ship
the private Go binary or an R2 configuration.
