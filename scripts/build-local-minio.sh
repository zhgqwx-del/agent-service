#!/usr/bin/env bash
# Build the repository-pinned official MinIO source into the ignored local tooling directory.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="${AGENT_SERVICE_TOOLING_DIR:-$ROOT/.local-run/tooling}"
CACHE_DIR="${AGENT_SERVICE_TOOLING_CACHE_DIR:-$ROOT/.local-run/tooling-cache}"
MINIO_COMMIT="07c3a429bfed433e49018cb0f78a52145d4bedeb"
MINIO_COMMIT_SHORT="${MINIO_COMMIT:0:12}"
GO_VERSION="1.24.8"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    GO_ARCHIVE="go${GO_VERSION}.darwin-arm64.tar.gz"
    GO_SHA256="0db27ff8c3e35fd93ccf9d31dd88a0f9c6454e8d9b30c28bd88a70b930cc4240"
    ;;
  Darwin-x86_64)
    GO_ARCHIVE="go${GO_VERSION}.darwin-amd64.tar.gz"
    GO_SHA256="ecb3cecb1e0bcfb24e50039701f9505b09744cc4730a8b9fc512b0a3b47cf232"
    ;;
  *)
    echo "unsupported local MinIO build host: $(uname -s) $(uname -m)" >&2
    echo "use deploy/local/compose.yaml or install Go ${GO_VERSION} and build the pinned commit manually" >&2
    exit 1
    ;;
esac

mkdir -p "$TOOLS_DIR" "$CACHE_DIR/downloads" "$CACHE_DIR/go-mod" "$CACHE_DIR/go-build"
command -v shasum >/dev/null || { echo "shasum is required" >&2; exit 1; }
GO_ROOT="$CACHE_DIR/go-${GO_VERSION}"
GO_BIN="$GO_ROOT/bin/go"
ARCHIVE_PATH="$CACHE_DIR/downloads/$GO_ARCHIVE"
MINIO_BIN="$TOOLS_DIR/minio"

if [ ! -x "$GO_BIN" ]; then
  command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
  if [ ! -f "$ARCHIVE_PATH" ]; then
    curl -fsSLo "$ARCHIVE_PATH" "https://go.dev/dl/$GO_ARCHIVE"
  fi
  actual_sha256="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
  if [ "$actual_sha256" != "$GO_SHA256" ]; then
    echo "Go archive checksum mismatch; refusing to execute it" >&2
    exit 1
  fi
  extract_dir="$(mktemp -d "$CACHE_DIR/go-extract.XXXXXX")"
  trap 'rm -rf "$extract_dir"' EXIT
  tar -xzf "$ARCHIVE_PATH" -C "$extract_dir"
  [ -x "$extract_dir/go/bin/go" ] || { echo "Go archive layout is invalid" >&2; exit 1; }
  mv "$extract_dir/go" "$GO_ROOT"
  trap - EXIT
  rmdir "$extract_dir"
fi

build_dir="$(mktemp -d "$CACHE_DIR/minio-build.XXXXXX")"
target_tmp=""
cleanup() {
  rm -rf "$build_dir"
  [ -z "$target_tmp" ] || rm -f "$target_tmp"
}
trap cleanup EXIT

GOTOOLCHAIN=local \
GOBIN="$build_dir" \
GOMODCACHE="$CACHE_DIR/go-mod" \
GOCACHE="$CACHE_DIR/go-build" \
GOPATH="$CACHE_DIR/go-path" \
  "$GO_BIN" install "github.com/minio/minio@$MINIO_COMMIT"

built_sha256="$(shasum -a 256 "$build_dir/minio" | awk '{print $1}')"
built_module="$("$GO_BIN" version -m "$build_dir/minio" | awk '$1 == "mod" { print $2 "@" $3; exit }')"
case "$built_module" in
  "github.com/minio/minio@"*"-$MINIO_COMMIT_SHORT") ;;
  *) echo "built MinIO module does not match the pinned commit: $built_module" >&2; exit 1 ;;
esac
if [ -e "$MINIO_BIN" ]; then
  [ -f "$MINIO_BIN" ] && [ -x "$MINIO_BIN" ] || {
    echo "refusing to replace non-executable or non-regular target: $MINIO_BIN" >&2
    exit 1
  }
  existing_sha256="$(shasum -a 256 "$MINIO_BIN" | awk '{print $1}')"
  if [ "$existing_sha256" != "$built_sha256" ]; then
    existing_module="$("$GO_BIN" version -m "$MINIO_BIN" 2>/dev/null \
      | awk '$1 == "mod" { print $2 "@" $3; exit }' || true)"
    echo "refusing to replace an existing, different MinIO binary" >&2
    echo "existing sha256=$existing_sha256 module=${existing_module:-unknown}" >&2
    echo "built sha256=$built_sha256 module=$built_module" >&2
    exit 1
  fi
  echo "local MinIO already matches the pinned build (sha256=$existing_sha256)"
else
  target_tmp="$(mktemp "$TOOLS_DIR/.minio.new.XXXXXX")"
  install -m 0755 "$build_dir/minio" "$target_tmp"
  if ! ln "$target_tmp" "$MINIO_BIN" 2>/dev/null; then
    echo "refusing to replace a MinIO target that appeared during the build: $MINIO_BIN" >&2
    exit 1
  fi
  rm -f "$target_tmp"
  target_tmp=""
fi

"$MINIO_BIN" --version | sed -n '1p'
echo "local MinIO ready: $MINIO_BIN"
