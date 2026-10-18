#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT/dist/macos"
APP_NAME="Conduit"
DMG_FILENAME="Conduit.dmg"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
DMG_ROOT="$DIST_DIR/dmg-root"
DMG_PATH="$DIST_DIR/$DMG_FILENAME"
CHECKSUM_PATH="$DMG_PATH.sha256"
APPCAST_PATH="$DIST_DIR/conduit-appcast.json"
APPCAST_PAYLOAD_PATH="$DIST_DIR/conduit-appcast.payload.json"
RELEASE_NOTES_PATH="$DIST_DIR/RELEASE_NOTES.txt"
VOLUME_NAME="${CONDUIT_DMG_VOLUME_NAME:-Conduit}"
RELEASE_CHANNEL="${CONDUIT_RELEASE_CHANNEL:-local-preview}"
RELEASE_NOTES="${CONDUIT_RELEASE_NOTES:-Local preview DMG generated from this checkout. This artifact is unsigned and not notarized.}"
# Path to the O+K release-manifest signer (ok-release-tools/scripts/sign-manifest.mjs). Required only when
# OK_RELEASE_PRIVATE_KEY_PEM is set; there is deliberately no machine-local default.
OK_RELEASE_SIGNER="${OK_RELEASE_SIGNER:-}"
MODE="${1:-}"

if ! command -v hdiutil >/dev/null 2>&1; then
  echo "hdiutil is required to create a macOS DMG." >&2
  exit 1
fi

case "$MODE" in
  "")
    "$ROOT/script/build_and_run.sh" --build-only
    ;;
  --skip-build)
    if [[ ! -d "$APP_BUNDLE" ]]; then
      echo "$APP_BUNDLE does not exist. Run npm run macos:build first." >&2
      exit 1
    fi
    ;;
  *)
    echo "Unknown option: $MODE" >&2
    echo "Usage: $0 [--skip-build]" >&2
    exit 2
    ;;
esac

rm -rf "$DMG_ROOT" "$DMG_PATH" "$CHECKSUM_PATH" "$APPCAST_PATH" "$APPCAST_PAYLOAD_PATH" "$RELEASE_NOTES_PATH"
mkdir -p "$DMG_ROOT"

/usr/bin/ditto "$APP_BUNDLE" "$DMG_ROOT/$APP_NAME.app"
ln -s /Applications "$DMG_ROOT/Applications"
cat > "$DMG_ROOT/README.txt" <<README
Conduit for macOS

Install:
1. Drag Conduit.app to Applications.
2. Launch Conduit from Applications.
3. Choose "Open Control Panel" from the menu-bar icon to pair the browser
   extension, create sessions, and review pending approvals.

This preview build is not signed or notarized yet. On first launch, macOS may
show a downloaded-app warning or block the app. If blocked, right-click
Conduit.app, choose Open, and confirm.

Conduit starts supervised local services when it launches. When you quit and
confirm "Quit and Stop Services", it stops those services too.
README

hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$DMG_ROOT" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

# Record the bare filename (not this machine's path) so `shasum -c` works
# from wherever the DMG is downloaded.
(cd "$DIST_DIR" && shasum -a 256 "$DMG_FILENAME") > "$CHECKSUM_PATH"
DMG_SHA256="$(awk '{print $1}' "$CHECKSUM_PATH")"
DMG_SIZE_BYTES="$(stat -f%z "$DMG_PATH")"

CONDUIT_VERSION="$(node -e "console.log(require('$ROOT/package.json').version)")"
if [[ -n "${CONDUIT_RELEASE_ARTIFACT_URL:-}" ]]; then
  CONDUIT_DMG_URL="$CONDUIT_RELEASE_ARTIFACT_URL"
elif [[ -n "${CONDUIT_RELEASE_BASE_URL:-}" ]]; then
  CONDUIT_DMG_URL="${CONDUIT_RELEASE_BASE_URL%/}/$DMG_FILENAME"
else
  CONDUIT_DMG_URL="$(node -e "console.log(new URL('file://' + process.argv[1]).href)" "$DMG_PATH")"
fi
CONDUIT_PUBLISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > "$RELEASE_NOTES_PATH" <<NOTES
Conduit $CONDUIT_VERSION ($RELEASE_CHANNEL)

$RELEASE_NOTES

Artifact:
- $DMG_FILENAME
- SHA-256: $DMG_SHA256
- Size: $DMG_SIZE_BYTES bytes
NOTES

CONDUIT_APP_ID="${CONDUIT_APP_ID:-conduit}" \
CONDUIT_PUBLISHER_ID="${CONDUIT_PUBLISHER_ID:-owl-kestrel}" \
CONDUIT_PUBLISHER_DOMAIN="${CONDUIT_PUBLISHER_DOMAIN:-owlandkestrel.com}" \
CONDUIT_VERSION="$CONDUIT_VERSION" \
CONDUIT_DMG_URL="$CONDUIT_DMG_URL" \
CONDUIT_DMG_SHA256="$DMG_SHA256" \
CONDUIT_DMG_SIZE_BYTES="$DMG_SIZE_BYTES" \
CONDUIT_PUBLISHED_AT="$CONDUIT_PUBLISHED_AT" \
CONDUIT_RELEASE_CHANNEL="$RELEASE_CHANNEL" \
CONDUIT_RELEASE_NOTES="$RELEASE_NOTES" \
node <<'NODE' > "$APPCAST_PAYLOAD_PATH"
const manifest = {
  schema: 'conduit.update-manifest.v1',
  appId: process.env.CONDUIT_APP_ID,
  publisherId: process.env.CONDUIT_PUBLISHER_ID,
  publisherDomain: process.env.CONDUIT_PUBLISHER_DOMAIN,
  version: process.env.CONDUIT_VERSION,
  channel: process.env.CONDUIT_RELEASE_CHANNEL,
  publishedAt: process.env.CONDUIT_PUBLISHED_AT,
  releaseNotes: process.env.CONDUIT_RELEASE_NOTES,
  artifacts: [
    {
      platform: 'macos-universal',
      url: process.env.CONDUIT_DMG_URL,
      sha256: process.env.CONDUIT_DMG_SHA256,
      sizeBytes: Number(process.env.CONDUIT_DMG_SIZE_BYTES),
      signature: null
    }
  ]
};

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
NODE

if [[ -n "${OK_RELEASE_PRIVATE_KEY_PEM:-}" ]]; then
  if [[ -z "$OK_RELEASE_SIGNER" || ! -f "$OK_RELEASE_SIGNER" ]]; then
    echo "OK_RELEASE_PRIVATE_KEY_PEM is set but OK_RELEASE_SIGNER does not point at sign-manifest.mjs." >&2
    exit 1
  fi
  OK_RELEASE_PRIVATE_KEY_PEM="$OK_RELEASE_PRIVATE_KEY_PEM" \
  OK_RELEASE_PUBLISHER_ID="${OK_RELEASE_PUBLISHER_ID:-owl-kestrel}" \
  OK_RELEASE_PUBLISHER_NAME="${OK_RELEASE_PUBLISHER_NAME:-Owl & Kestrel}" \
  OK_RELEASE_PUBLISHER_DOMAIN="${OK_RELEASE_PUBLISHER_DOMAIN:-owlandkestrel.com}" \
  OK_RELEASE_KEY_ID="${OK_RELEASE_KEY_ID:-ok-release-p256-v1}" \
  node "$OK_RELEASE_SIGNER" "$APPCAST_PAYLOAD_PATH" "$APPCAST_PATH"
else
  cp "$APPCAST_PAYLOAD_PATH" "$APPCAST_PATH"
fi

echo "Created $DMG_PATH"
echo "Wrote $CHECKSUM_PATH"
echo "Wrote $APPCAST_PATH"
echo "Wrote $APPCAST_PAYLOAD_PATH"
echo "Wrote $RELEASE_NOTES_PATH"
