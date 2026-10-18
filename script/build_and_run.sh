#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_REAL="$(cd "$ROOT" && pwd -P)"
PACKAGE_DIR="$ROOT/macos/ConduitMenuBar"
PRODUCT="ConduitMenuBar"
APP_NAME="Conduit"
BUNDLE_ID="app.conduit.local"
DIST_DIR="$ROOT/dist/macos"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
# This checkout's app executable, as written and with symlinks resolved. Only
# processes running exactly this path are ever stopped (this_checkout_app_pids).
APP_EXECUTABLE="$APP_BUNDLE/Contents/MacOS/$APP_NAME"
APP_EXECUTABLE_REAL="$ROOT_REAL/dist/macos/$APP_NAME.app/Contents/MacOS/$APP_NAME"
SWIFT_BUILD_DIR="${CONDUIT_SWIFT_BUILD_DIR:-${TMPDIR:-/tmp}/conduit-menubar-build}"
EXECUTABLE="$SWIFT_BUILD_DIR/debug/$PRODUCT"
CONDUIT_VERSION="$(node -e "console.log(require('$ROOT/package.json').version)")"
CONDUIT_BUILD_NUMBER="${CONDUIT_BUILD_NUMBER:-1}"
CONDUIT_OK_PUBLISHER_ID="${CONDUIT_OK_PUBLISHER_ID:-owl-kestrel}"
CONDUIT_OK_PUBLISHER_DOMAIN="${CONDUIT_OK_PUBLISHER_DOMAIN:-owlandkestrel.com}"
CONDUIT_OK_PUBLISHER_KEY_ID="${CONDUIT_OK_PUBLISHER_KEY_ID:-ok-release-p256-v1}"
CONDUIT_OK_PUBLISHER_PUBLIC_KEY_PEM="${CONDUIT_OK_PUBLISHER_PUBLIC_KEY_PEM:-}"

MODE="${1:-}"
# CONDUIT_BUILD_DRY_RUN=1 prints what the chosen mode would stop, then exits.
# It builds, stops and launches nothing.
DRY_RUN="${CONDUIT_BUILD_DRY_RUN:-0}"

case "$MODE" in
  ""|--build-only|--verify|--logs|--debug)
    ;;
  *)
    echo "Unknown option: $MODE" >&2
    echo "Usage: $0 [--build-only|--verify|--logs|--debug]" >&2
    exit 2
    ;;
esac

# Prints the pid of every process whose executable path (argv[0], as ps reports
# it) is exactly this checkout's app executable. A Conduit.app from another
# checkout, an installed /Applications/Conduit.app, or any other process named
# Conduit never matches. Never stop Conduit processes by name.
this_checkout_app_pids() {
  /bin/ps -A -o pid= -o comm= | while read -r pid exe; do
    if [ "$exe" = "$APP_EXECUTABLE" ] || [ "$exe" = "$APP_EXECUTABLE_REAL" ]; then
      echo "$pid"
    fi
  done
}

# Run modes replace and relaunch this checkout's app, so they stop the app
# running from this checkout's bundle, plus legacy service processes started
# from this same checkout before supervision existed (their command line names
# $ROOT). --build-only never calls this.
stop_this_checkout_app() {
  local pids
  pids="$(this_checkout_app_pids | /usr/bin/tr '\n' ' ')"
  pids="${pids% }"
  if [ "$DRY_RUN" = "1" ]; then
    echo "Dry run: would stop this checkout's app: ${pids:-none}"
    echo "Dry run: would stop legacy service processes whose command line names $ROOT"
    return 0
  fi
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086 # one pid per word
    kill -TERM $pids 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ -z "$(this_checkout_app_pids)" ] && break
      sleep 0.5
    done
    if [ -n "$(this_checkout_app_pids)" ]; then
      echo "Warning: $APP_NAME from $APP_BUNDLE did not exit within 5 s." >&2
    fi
  fi
  /usr/bin/pkill -TERM -f "$ROOT.*src/cli/index.ts app start --port 47831" >/dev/null 2>&1 || true
  /usr/bin/pkill -TERM -f "$ROOT.*src/cli/index.ts daemon start" >/dev/null 2>&1 || true
  /usr/bin/pkill -TERM -f "$ROOT.*src/cli/index.ts listen --project" >/dev/null 2>&1 || true
  /usr/bin/pkill -TERM -f "$ROOT.*dist/cli/index.js app start --port 47831" >/dev/null 2>&1 || true
  /usr/bin/pkill -TERM -f "$ROOT.*dist/cli/index.js daemon start" >/dev/null 2>&1 || true
  /usr/bin/pkill -TERM -f "$ROOT.*dist/cli/index.js listen --project" >/dev/null 2>&1 || true
}

stage_bundle() {
  rm -rf "$APP_BUNDLE"
  mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
  cp "$EXECUTABLE" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
  cp "$PACKAGE_DIR/Assets/ConduitIcon.svg" "$APP_BUNDLE/Contents/Resources/ConduitIcon.svg"
  PUBLIC_KEY_PLIST="$(CONDUIT_OK_PUBLISHER_PUBLIC_KEY_PEM="$CONDUIT_OK_PUBLISHER_PUBLIC_KEY_PEM" node <<'NODE'
const raw = process.env.CONDUIT_OK_PUBLISHER_PUBLIC_KEY_PEM || '';
process.stdout.write(raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
NODE
)"
  cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>$BUNDLE_ID.url</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>conduit</string>
      </array>
    </dict>
  </array>
  <key>CFBundleShortVersionString</key>
  <string>$CONDUIT_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$CONDUIT_BUILD_NUMBER</string>
  <key>ConduitOKPublisherID</key>
  <string>$CONDUIT_OK_PUBLISHER_ID</string>
  <key>ConduitOKPublisherDomain</key>
  <string>$CONDUIT_OK_PUBLISHER_DOMAIN</string>
  <key>ConduitOKPublisherKeyID</key>
  <string>$CONDUIT_OK_PUBLISHER_KEY_ID</string>
  <key>ConduitOKPublisherPublicKeyPEM</key>
  <string>$PUBLIC_KEY_PLIST</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST
}

launch_bundle() {
  CONDUIT_REPO_ROOT="$ROOT" /usr/bin/open -n "$APP_BUNDLE"
}

verify_launch() {
  sleep 1
  if [ -n "$(this_checkout_app_pids)" ]; then
    echo "$APP_NAME launched."
  else
    echo "$APP_NAME did not appear to launch." >&2
    exit 1
  fi
}

if [ "$DRY_RUN" = "1" ]; then
  if [ "$MODE" = "--build-only" ]; then
    echo "Dry run: --build-only stops no process."
  else
    stop_this_checkout_app
  fi
  echo "Dry run: nothing was built, stopped or launched."
  exit 0
fi

swift build --package-path "$PACKAGE_DIR" --scratch-path "$SWIFT_BUILD_DIR"
# --build-only stops nothing: a Conduit that is already running (from this
# checkout or any other) keeps running. Relaunch it to pick up the new build.
if [ "$MODE" != "--build-only" ]; then
  stop_this_checkout_app
fi
stage_bundle

case "$MODE" in
  --build-only)
    echo "Built $APP_BUNDLE"
    ;;
  --verify)
    launch_bundle
    verify_launch
    ;;
  --logs)
    launch_bundle
    /usr/bin/log stream --info --predicate 'process == "Conduit" || process == "ConduitMenuBar"'
    ;;
  --debug)
    CONDUIT_REPO_ROOT="$ROOT" /usr/bin/lldb "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
    ;;
  "")
    launch_bundle
    echo "Launched $APP_BUNDLE"
    ;;
esac
