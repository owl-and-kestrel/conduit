#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT/dist/linux"
PACKAGE_ROOT="$DIST_DIR/conduit-linux-x64"
ARCHIVE_PATH="$DIST_DIR/conduit-linux-x64.tar.gz"
MODE="${1:-}"

case "$MODE" in
  "")
    npm --prefix "$ROOT" run build
    ;;
  --skip-build)
    if [[ ! -d "$ROOT/dist" ]]; then
      echo "$ROOT/dist does not exist. Run npm run build first." >&2
      exit 1
    fi
    ;;
  *)
    echo "Unknown option: $MODE" >&2
    echo "Usage: $0 [--skip-build]" >&2
    exit 2
    ;;
esac

rm -rf "$PACKAGE_ROOT" "$ARCHIVE_PATH"
mkdir -p "$PACKAGE_ROOT/bin" "$PACKAGE_ROOT/share/applications" "$PACKAGE_ROOT/runtime" "$PACKAGE_ROOT/platforms"

# No devDependencies: the package must install from the public registry alone.
node "$ROOT/script/packaged_package_json.mjs" "$ROOT/package.json" "$PACKAGE_ROOT/package.json"
mkdir -p "$PACKAGE_ROOT/runtime/dist"
cp -R "$ROOT/dist/src" "$PACKAGE_ROOT/runtime/dist/src"
cp -R "$ROOT/dist/scripts" "$PACKAGE_ROOT/runtime/dist/scripts"
cp -R "$ROOT/platforms/linux/bin/." "$PACKAGE_ROOT/bin/"
cp "$ROOT/platforms/linux/share/applications/conduit.desktop" "$PACKAGE_ROOT/share/applications/conduit.desktop"
cp "$ROOT/platforms/desktop-shell-contract.md" "$PACKAGE_ROOT/desktop-shell-contract.md"
cp "$ROOT/platforms/linux/README.md" "$PACKAGE_ROOT/platforms-linux.md"
chmod +x "$PACKAGE_ROOT"/bin/*

cat > "$PACKAGE_ROOT/README.txt" <<README
Conduit for Linux preview

Install:
1. Extract this archive.
2. Run npm install --omit=dev from the extracted directory.
3. Run ./bin/conduit-control to start the local control panel.
4. Run ./bin/conduit-agent-listener for browser agent-loop transport.
5. Run ./bin/conduit-clipboard-daemon for exact-envelope clipboard monitoring.

Report bugs:
- Run ./bin/conduit-report-bug to open the redacted diagnostics view.
- Diagnostics preview excludes clipboard contents, request payloads, file
  contents, session nonces, API keys, environment variables, and secrets.

This preview is not a native tray/status shell yet. The native shell must follow
desktop-shell-contract.md.
README

tar -C "$DIST_DIR" -czf "$ARCHIVE_PATH" "$(basename "$PACKAGE_ROOT")"

echo "Created $ARCHIVE_PATH"
