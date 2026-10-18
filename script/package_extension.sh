#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT/dist/extension"
PACKAGE_ROOT="$DIST_DIR/conduit-bridge-extension"
ARCHIVE_PATH="$DIST_DIR/conduit-bridge-extension.zip"

rm -rf "$PACKAGE_ROOT" "$ARCHIVE_PATH"
mkdir -p "$PACKAGE_ROOT"

cp "$ROOT/extension/manifest.json" "$PACKAGE_ROOT/manifest.json"
cp "$ROOT/extension/background.js" "$PACKAGE_ROOT/background.js"
cp "$ROOT/extension/bridge-client.js" "$PACKAGE_ROOT/bridge-client.js"
cp "$ROOT/extension/content.js" "$PACKAGE_ROOT/content.js"
cp "$ROOT/extension/popup.html" "$PACKAGE_ROOT/popup.html"
cp "$ROOT/extension/popup.css" "$PACKAGE_ROOT/popup.css"
cp "$ROOT/extension/popup.js" "$PACKAGE_ROOT/popup.js"

cat > "$PACKAGE_ROOT/ALPHA_INSTALL.txt" <<'README'
Conduit Bridge Extension - Alpha Install

This is an optional developer-mode Chrome/Brave extension for paired ChatGPT
transport. Conduit clipboard-only workflows do not require it.

Install:
1. Unzip conduit-bridge-extension.zip.
2. Open Chrome or Brave.
3. Go to chrome://extensions/.
4. Enable Developer mode.
5. Click Load unpacked.
6. Select the unzipped conduit-bridge-extension folder.
7. Reload your ChatGPT tab.

The extension highlights/copies Conduit protocol blocks and can bridge paired
ChatGPT agent-loop messages to the local Conduit desktop app. It does not approve
or execute local actions by itself.

This developer-mode package is an alpha stopgap until the extension is published
as an unlisted Chrome Web Store item.
README

(cd "$DIST_DIR" && /usr/bin/zip -qr "$ARCHIVE_PATH" "$(basename "$PACKAGE_ROOT")")

echo "Created $ARCHIVE_PATH"
