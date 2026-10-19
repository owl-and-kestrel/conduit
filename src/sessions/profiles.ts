// 'demo-review' exists only for an approved untrusted review while the demo
// profile is on. It is deliberately NOT accepted by isPermissionProfileName
// below, so no session, CLI flag or API body can ever select it: the only
// code that creates a 'demo-review' session is createApprovedReviewPolicySession
// in src/daemon/execute-request.ts, at the moment the person approves.
export type PermissionProfileName = 'read-only' | 'edit-with-confirmation' | 'shell-manual' | 'demo-review';

export interface PermissionProfile {
  name: PermissionProfileName;
  autoAllow: string[];
  requireConfirmation: string[];
  deny: string[];
}

export const PROFILES: Record<PermissionProfileName, PermissionProfile> = {
  'read-only': {
    name: 'read-only',
    autoAllow: ['file.read', 'file.list', 'git.status', 'git.diff', 'conduit.about', 'conduit.help', 'conduit.extension.prepareAlphaInstall'],
    requireConfirmation: [],
    deny: ['file.patch', 'file.write', 'shell.run']
  },
  'edit-with-confirmation': {
    name: 'edit-with-confirmation',
    autoAllow: ['file.read', 'file.list', 'git.status', 'git.diff', 'conduit.about', 'conduit.help', 'conduit.extension.prepareAlphaInstall'],
    requireConfirmation: ['file.patch', 'file.write'],
    deny: ['shell.run']
  },
  'shell-manual': {
    name: 'shell-manual',
    autoAllow: ['file.read', 'file.list', 'git.status', 'git.diff', 'conduit.about', 'conduit.help', 'conduit.extension.prepareAlphaInstall'],
    requireConfirmation: ['file.patch', 'file.write', 'shell.run'],
    deny: []
  },
  // Used only for an approved untrusted review while the demo profile is on
  // (createApprovedReviewPolicySession in src/daemon/execute-request.ts). The
  // person already approved this exact request, so its actions are not asked
  // again. file.patch and file.write stay denied because the demo decision
  // covered running programs only, not writing files.
  'demo-review': {
    name: 'demo-review',
    autoAllow: ['file.read', 'file.list', 'git.status', 'git.diff', 'conduit.about', 'conduit.help', 'conduit.extension.prepareAlphaInstall', 'shell.run', 'service.start'],
    requireConfirmation: [],
    deny: ['file.patch', 'file.write']
  }
};

// Explicit three-name check on purpose: it must NOT accept 'demo-review', so
// no session, CLI flag or API body can ever select the demo review profile.
export function isPermissionProfileName(value: string): value is PermissionProfileName {
  return value === 'read-only' || value === 'edit-with-confirmation' || value === 'shell-manual';
}
