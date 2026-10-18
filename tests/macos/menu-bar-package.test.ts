import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROL_CLI_ROUTES } from '../../src/cli/control-client.js';

describe('macOS menu-bar package scaffold', () => {
  it('ships a SwiftPM menu-bar app and build script', async () => {
    await expectExists('macos/ConduitMenuBar/Package.swift');
    await expectExists('macos/ConduitMenuBar/Sources/ConduitMenuBar/main.swift');
    await expectExists('macos/ConduitMenuBar/Sources/ConduitMenuBarCore/MenuBarState.swift');
    await expectExists('macos/ConduitMenuBar/Sources/ConduitMenuBarCore/ControlAPI.swift');
    await expectExists('macos/ConduitMenuBar/Tests/ConduitMenuBarCoreTests/MenuBarStateTests.swift');
    await expectExists('macos/ConduitMenuBar/Tests/ConduitMenuBarCoreTests/AllowOnceTests.swift');
    await expectExists('macos/ConduitMenuBar/Tests/ConduitMenuBarCoreTests/ControlAdoptionTests.swift');
    await expectExists('macos/ConduitMenuBar/Assets/ConduitIcon.svg');
    await expectExists('script/build_and_run.sh');
    await expectExists('script/package_dmg.sh');
    await expectExists('script/package_extension.sh');

    const main = await swiftSources();
    expect(main).toContain('NSStatusBar.system.statusItem');
    expect(main).toContain('Start Clipboard Daemon');
    expect(main).toContain('Start Agent Listener');
    expect(main).toContain('startDaemon()');
    expect(main).toContain('startAgentListener()');
    expect(main).toContain('startControlApp()');
    expect(main).toContain('applicationShouldTerminate');
    expect(main).toContain('application(_ application: NSApplication, open urls: [URL])');
    expect(main).toContain('handleConduitURL');
    expect(main).toContain('/api/url/open');
    expect(main).toContain('Conduit link executed');
    expect(main).toContain('Copy Agent Handshake');
    expect(main).toContain('/api/agent-handshake');
    expect(main).toContain('NSPasteboard.general');
    expect(main).toContain('Quit and Stop Services');
    expect(main).toContain('Keep Running');
    expect(main).toContain('ProcessSignals.terminateTree');
    expect(main).not.toContain('/usr/bin/pgrep');
    expect(main).toContain('Check for Updates');
    expect(main).toContain('scheduleStartupUpdateCheck');
    expect(main).toContain('notifyWhenCurrent: false');
    expect(main).toContain('Install Update');
    expect(main).toContain('CryptoKit');
    expect(main).toContain('ok.signed-manifest.v1');
    expect(main).toContain('ECDSA_P256_SHA256_DER');
    expect(main).toContain('ConduitOKPublisherPublicKeyPEM');
    expect(main).toContain('https://owlandkestrel.com/releases/conduit/appcast.json');
    expect(main).toContain('Refusing to install an update from an unsigned manifest.');
    expect(main).toContain('Downloaded update hash did not match the signed manifest.');
    expect(main).toContain('hdiutil attach');
    expect(main).toContain('ditto "$MOUNT_POINT/Conduit.app" "$APP_PATH"');
    expect(main).toContain('/usr/bin/open -n "$APP_PATH"');
    expect(main).toContain('Open Logs');
    expect(main).toContain('Report Bug');
    expect(main).toContain('openDiagnostics');
    expect(main).toContain('#diagnostics');
    expect(main).toContain('redacted diagnostic bundle');
    expect(main).toContain('Logs/Conduit');
    expect(main).toContain('/api/status');
    expect(main).toContain('http://127.0.0.1:3333/health');
    expect(main).toContain('needs attention');
    expect(main).toContain('UNUserNotificationCenter');
    expect(main).toContain('removeDeliveredNotifications');
    expect(main).toContain('/api/approvals');
    expect(main).toContain('Conduit approval required');
    expect(main).toContain('Run \\(runId) is ready in Conduit.');
    expect(main).toContain('Approved from Conduit menu bar.');
    expect(main).toContain('Approved from Conduit notification.');
    expect(main).toContain('#approvals');
    expect(main).toContain('Control App Already Running');
    expect(main).toContain('Control App Needs Restart');
    expect(main).toContain('agentHandshake');
    expect(main).toContain('restartStaleControlApp');
    expect(main).toContain('listenerPids(on: 47831)');
    expect(main).toContain('ownedListeners(on: 47831, service: .control)');
    expect(main).toContain('ownedListeners(on: 3333, service: .agentListener)');
    expect(main).toContain('ListenerOwnership.classify');
    expect(main).not.toContain('dist/cli/index.js');
    // A Control already on 47831 is adopted only when it reports this checkout;
    // nothing but /api/status is read from another checkout's, and it is reported.
    expect(main).toContain('ControlAdoption.evaluate(status, appCheckoutRoot:');
    expect(main).toContain('if adopted { try? await client.approvals() }');
    expect(main).toContain('guard controlAdoption.adopted else');
    expect(main).toContain('otherCheckoutControlError(reportedRoot:');
    // Review F-02 (d448c788): restartStaleControlApp lists the port once.
    const restart = sliceBetween(main, 'private func restartStaleControlApp', 'private func waitForPortToClear');
    expect(restart).not.toContain('listenerPids(');
    expect(restart.split('ownedListeners(on: 47831, service: .control)').length - 1).toBe(1);
    expect(main).toContain('agent-listener.log');
    expect(main).toContain('"listen", "--project"');
    expect(main).toContain('standardOutput = handle');
    expect(main).toContain('standardError = handle');
    expect(main).toContain('/bin/zsh');
    expect(main).toContain('nvm.sh');
    expect(main).toContain('exec \\(command)');
    expect(main).toContain('CONDUIT_PARENT_PID');
    expect(main).toContain('/opt/homebrew/bin');
    expect(main).toContain('CONDUIT_UPDATE_MANIFEST_URL');
    expect(main).toContain('CONDUIT_REPO_ROOT');
    expect(main).toContain('dist/macos/conduit-appcast.json');
    expect(main).toContain('website/releases/conduit-appcast.json');

    const script = await readText('script/build_and_run.sh');
    expect(script).toContain('SWIFT_BUILD_DIR="${CONDUIT_SWIFT_BUILD_DIR:-${TMPDIR:-/tmp}/conduit-menubar-build}"');
    expect(script).toContain('swift build --package-path "$PACKAGE_DIR" --scratch-path "$SWIFT_BUILD_DIR"');
    // Run modes stop this checkout's app and its child processes (the supervised
    // services) by process tree, never by command-line pattern (review F-01).
    expect(script).toContain('descendant_pids "$pid"');
    expect(script).not.toContain('pkill');
    expect(script).toContain('LSUIElement');
    expect(script).toContain('CFBundleURLTypes');
    expect(script).toContain('<string>conduit</string>');
    expect(script).toContain('CONDUIT_REPO_ROOT="$ROOT" /usr/bin/open -n "$APP_BUNDLE"');
    expect(script).toContain('CFBundleShortVersionString');
    expect(script).toContain('CONDUIT_OK_PUBLISHER_PUBLIC_KEY_PEM');
    expect(script).toContain('ConduitOKPublisherKeyID');

    const packageScript = await readText('script/package_dmg.sh');
    expect(packageScript).toContain('hdiutil create');
    expect(packageScript).toContain('Conduit.dmg');
    expect(packageScript).toContain('--skip-build');
    expect(packageScript).toContain('ln -s /Applications');
    expect(packageScript).toContain('README.txt');
    expect(packageScript).toContain('shasum -a 256');
    expect(packageScript).toContain('conduit-appcast.json');
    expect(packageScript).toContain('CONDUIT_DMG_SHA256');
    expect(packageScript).toContain('CONDUIT_RELEASE_ARTIFACT_URL');
    expect(packageScript).toContain('CONDUIT_RELEASE_BASE_URL');
    expect(packageScript).toContain('CONDUIT_RELEASE_CHANNEL');
    expect(packageScript).toContain('CONDUIT_DMG_SIZE_BYTES');
    expect(packageScript).toContain('APPCAST_PAYLOAD_PATH');
    expect(packageScript).toContain('OK_RELEASE_PRIVATE_KEY_PEM');
    expect(packageScript).toContain('ok-release-tools/scripts/sign-manifest.mjs');
    expect(packageScript).toContain('publisherDomain');
    expect(packageScript).toContain('RELEASE_NOTES.txt');
    expect(packageScript).toContain("new URL('file://' + process.argv[1]).href");
    expect(packageScript).toContain('Local preview DMG generated from this checkout');

    const extensionPackageScript = await readText('script/package_extension.sh');
    expect(extensionPackageScript).toContain('conduit-bridge-extension.zip');
    expect(extensionPackageScript).toContain('Load unpacked');
    expect(extensionPackageScript).toContain('ALPHA_INSTALL.txt');
  });

  it('ships a local update manifest with release-artifact metadata', async () => {
    const text = await readText('website/releases/conduit-appcast.json');
    const manifest = JSON.parse(text);
    expect(manifest).toMatchObject({
      schema: 'conduit.update-manifest.v1',
      appId: 'conduit',
      publisherId: 'owl-kestrel',
      publisherDomain: 'owlandkestrel.com',
      version: '0.0.1',
      channel: 'local-preview'
    });
    expect(manifest.artifacts[0]).toMatchObject({
      platform: 'macos-universal',
      sha256: 'local-preview-sha256-published-with-release',
      sizeBytes: 0
    });
    expect(manifest.artifacts[0].url).toContain('Conduit.dmg');
  });

  it('validates Conduit manifests against Hatch product-update contracts', async () => {
    const { parseProductUpdateManifest } = await import('@owl-kestrel/hatch-contracts');
    const text = await readText('website/releases/conduit-appcast.json');
    const manifest = JSON.parse(text);

    const hatchManifest = {
      schema: 'ok.product-update.v1',
      appId: manifest.appId,
      bundleId: 'com.owlandkestrel.conduit',
      version: manifest.version,
      build: 1,
      channel: manifest.channel,
      publishedAt: manifest.publishedAt || new Date().toISOString(),
      downloadPageUrl: 'https://owlandkestrel.com/apps/conduit',
      updateFeed: {
        format: 'conduit.appcast.v1',
        url: 'https://updates.owlandkestrel.com/conduit/stable/appcast.json',
        sha256: '0'.repeat(64)
      },
      source: {
        repository: 'https://github.com/owl-and-kestrel/conduit.git',
        commit: '0'.repeat(40),
        dirty: false,
        buildConfiguration: 'release'
      },
      artifacts: [
        {
          platform: 'macos',
          kind: 'archive' as const,
          url: manifest.artifacts[0].url,
          sha256: 'a'.repeat(64),
          sizeBytes: 1024
        }
      ]
    };

    const parsed = parseProductUpdateManifest(hatchManifest);
    expect(parsed.appId).toBe('conduit');
    expect(parsed.version).toBe('0.0.1');
    expect(parsed.artifacts[0].platform).toBe('macos');
  });

  it('loads the extension on ChatGPT origins and permits localhost bridge access', async () => {
    const manifest = JSON.parse(await readText('extension/manifest.json'));
    expect(manifest.host_permissions).toEqual(expect.arrayContaining([
      'http://127.0.0.1:3333/*',
      'https://chatgpt.com/*',
      'https://*.chatgpt.com/*',
      'https://chat.openai.com/*'
    ]));
    expect(manifest.action).toMatchObject({
      default_popup: 'popup.html'
    });
    expect(manifest.content_scripts[0].matches).toEqual(expect.arrayContaining([
      'https://chatgpt.com/*',
      'https://*.chatgpt.com/*',
      'https://chat.openai.com/*'
    ]));

    const background = await readText('extension/background.js');
    const content = await readText('extension/content.js');
    const popup = await readText('extension/popup.js');
    expect(background).toContain('/api/conduit-tab-status');
    expect(content).toContain('content_script_alive');
    expect(content).toContain('outbound_received');
    expect(content).toContain("['conduit', 'conduit-call'");
    expect(content).toContain('safeSendMessage');
    expect(content).toContain('getRuntimeLastError');
    expect(content).toContain('scheduleOutboundPoll');
    expect(content).toContain('Extension context invalidated');
    expect(content).toContain('decorateProtocolBlocks');
    expect(content).toContain('conduit-protocol-header');
    expect(content).toContain('Local execution requires Conduit desktop');
    expect(popup).toContain('/api/conduit-retry');
    expect(popup).toContain('attentionOutboundIds');
    expect(popup).toContain('Retry available');
    expect(popup).toContain('bridgeCanRetry');
    expect(popup).toContain('tabAvailabilityLabel');
    expect(popup).toContain('unavailable');
    const popupHtml = await readText('extension/popup.html');
    expect(popupHtml).toContain('Desktop app not connected');
    expect(popupHtml).toContain('https://github.com/owl-and-kestrel/conduit');
    expect(popupHtml).toContain('Report Bug');
    expect(popupHtml).toContain('http://127.0.0.1:47831#diagnostics');
  });

  it('exposes package scripts and a Codex run action for local launch', async () => {
    const packageJson = JSON.parse(await readText('package.json'));
    expect(packageJson.scripts['macos:build']).toBe('./script/build_and_run.sh --build-only');
    expect(packageJson.scripts['macos:run']).toBe('./script/build_and_run.sh');
    expect(packageJson.scripts['macos:package']).toBe('./script/package_dmg.sh');
    expect(packageJson.scripts['extension:package']).toBe('./script/package_extension.sh');

    const environment = await readText('.codex/environments/environment.toml');
    expect(environment).toContain('[actions.Run]');
    expect(environment).toContain('./script/build_and_run.sh');
  });
});

describe('menu-bar-first popover and notifications (spec S5/S6)', () => {
  it('ships a core library with an XCTest target', async () => {
    const manifest = await readText('macos/ConduitMenuBar/Package.swift');
    expect(manifest).toContain('name: "ConduitMenuBarCore"');
    expect(manifest).toContain('.testTarget(');
    expect(manifest).toContain('dependencies: ["ConduitMenuBarCore"]');
  });

  it('replaces the NSMenu, service toggles and NSAlert approval prompt with a popover', async () => {
    const swift = await swiftSources();
    expect(swift).toContain('NSPopover');
    expect(swift).toContain('NSHostingController');
    expect(swift).toContain('Pause all');
    expect(swift).toContain('Stop all');
    expect(swift).toContain('Settings…');
    // Removed by S5 (spec §3.4 "Delete from the menu").
    expect(swift).not.toContain('statusItem.menu =');
    expect(swift).not.toContain('NSMenuItem(');
    expect(swift).not.toContain('Pending Approvals');
    expect(swift).not.toContain('Open Desktop Details');
    expect(swift).not.toContain('Open Browser Details');
    expect(swift).not.toContain('ConduitApprovalDetailsPreference');
    expect(swift).not.toContain('presentApprovalPrompt');
    expect(swift).not.toContain('statusTitle()');
    // Service toggles live only in the native Settings window now.
    const popover = await readText('macos/ConduitMenuBar/Sources/ConduitMenuBar/PopoverView.swift');
    expect(popover).not.toContain('Clipboard Daemon');
    expect(popover).not.toContain('Agent Listener');
  });

  it('records which surface decided and pauses through the Control API', async () => {
    const swift = await swiftSources();
    expect(swift).toContain('case menubar');
    expect(swift).toContain('case notification');
    expect(swift).toContain('"decidedBy": channel.rawValue');
    expect(swift).toContain('["by": channel.rawValue]');
    expect(swift).toContain('stop(force: true)');
    expect(swift).toContain('"stop-all", "--local"');
    expect(swift).toContain('UNNotificationCategory');
    expect(swift).toContain('RegisterEventHotKey');
    expect(swift).toContain('Conduit is paused, so this was not approved');
    expect(swift).toContain('paused before this request ran, so nothing ran');
    expect(swift).toContain('expired and was denied');
  });

  it('calls only Control endpoints that have a CLI verb (spec §3.5 parity)', async () => {
    const api = await readText('macos/ConduitMenuBar/Sources/ConduitMenuBarCore/ControlAPI.swift');
    const swiftPaths = [...api.matchAll(/return "(\/api\/[^"]+)"/g)]
      .map((match) => match[1]!.replace(/\\\([^)]*\)/g, ':id'));
    expect(swiftPaths).toEqual(expect.arrayContaining(['/api/control/pause', '/api/control/stop-all', '/api/approvals/:id/approve', '/api/approvals/:id/deny']));
    const cliPaths = new Set<string>(Object.values(CONTROL_CLI_ROUTES).map((route) => route.path));
    // /api/status is the health probe; `conduit status` reads /api/control.
    for (const swiftPath of swiftPaths.filter((candidate) => candidate !== '/api/status')) {
      expect(cliPaths, swiftPath).toContain(swiftPath);
    }
  });
});

describe('menu-bar supervisor safety (spec invariant 5)', () => {
  it('never starts a supervised service with --yes', async () => {
    const main = await swiftSources();
    const starts = main.match(/\.start\(arguments: \[[^\]]*\]\)/g) ?? [];
    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (const start of starts) {
      expect(start).not.toContain('--yes');
    }
    expect(main).not.toContain('"--yes"');
  });
});

async function expectExists(file: string): Promise<void> {
  await expect(access(path.resolve(file))).resolves.toBeUndefined();
}

/** Every Swift source of the menu-bar app and its core library, concatenated. */
function sliceBetween(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  expect(from, start).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return text.slice(from, to);
}

async function swiftSources(): Promise<string> {
  const roots = [
    'macos/ConduitMenuBar/Sources/ConduitMenuBar',
    'macos/ConduitMenuBar/Sources/ConduitMenuBarCore'
  ];
  const texts: string[] = [];
  for (const root of roots) {
    const names = (await readdir(path.resolve(root))).filter((name) => name.endsWith('.swift')).sort();
    for (const name of names) {
      texts.push(await readText(path.join(root, name)));
    }
  }
  return texts.join('\n');
}

async function readText(file: string): Promise<string> {
  return readFile(path.resolve(file), 'utf8');
}
