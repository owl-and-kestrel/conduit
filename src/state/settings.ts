import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { withFileLock } from './file-lock.js';
import { getStateRoot } from './paths.js';

/**
 * Conduit settings: one small JSON file in the state root (`settings.json`).
 *
 * Every setting is the same Control call from every surface (UI is an API
 * control plane): `GET/POST /api/settings`, `conduit settings show/set`, the
 * web panel and the menu-bar Settings window.
 *
 * The defaults are the cautious choices, so a missing or unreadable file means
 * the defaults and never a looser behaviour.
 */
export interface ConduitSettings {
  /**
   * Jon 2026-10-18: Return must not approve a shell command whose details are
   * closed; Return opens the details instead. On means Return approves a shell
   * command straight away. Off by default.
   */
  returnApprovesShellWithoutDetails: boolean;
}

export const DEFAULT_SETTINGS: Readonly<ConduitSettings> = Object.freeze({
  returnApprovesShellWithoutDetails: false
});

const BOOLEAN_SETTINGS = ['returnApprovesShellWithoutDetails'] as const;

export class SettingsValidationError extends Error {}

export function getSettingsPath(): string {
  return path.join(getStateRoot(), 'settings.json');
}

export async function getSettings(): Promise<ConduitSettings> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(getSettingsPath(), 'utf8'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  const settings: ConduitSettings = { ...DEFAULT_SETTINGS };
  if (typeof parsed === 'object' && parsed !== null) {
    for (const key of BOOLEAN_SETTINGS) {
      const value = (parsed as Record<string, unknown>)[key];
      // Only a real boolean counts; anything else keeps the cautious default.
      if (typeof value === 'boolean') settings[key] = value;
    }
  }
  return settings;
}

/** Validates a partial update: only known keys, each a boolean. */
export function parseSettingsUpdate(body: unknown): Partial<ConduitSettings> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new SettingsValidationError('Settings must be a JSON object.');
  }
  const update: Partial<ConduitSettings> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(BOOLEAN_SETTINGS as readonly string[]).includes(key)) {
      throw new SettingsValidationError(`Unknown setting: ${key}`);
    }
    if (typeof value !== 'boolean') {
      throw new SettingsValidationError(`Setting ${key} must be true or false.`);
    }
    update[key as typeof BOOLEAN_SETTINGS[number]] = value;
  }
  if (Object.keys(update).length === 0) {
    throw new SettingsValidationError('No setting to change.');
  }
  return update;
}

export async function updateSettings(update: Partial<ConduitSettings>): Promise<ConduitSettings> {
  const validated = parseSettingsUpdate(update);
  return withFileLock(getSettingsPath(), async () => {
    const next: ConduitSettings = { ...(await getSettings()), ...validated };
    await writeFileAtomic(getSettingsPath(), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}
