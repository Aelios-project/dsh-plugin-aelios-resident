export const HELPER_PRESET = 'aelios-resident-helper';
export const FULL_HELPER_PRESET = 'aelios-resident-helper-full';
export const helperAccess = value => value === 'full' ? 'full' : 'read-only';
export const helperPreset = access => helperAccess(access) === 'full' ? FULL_HELPER_PRESET : HELPER_PRESET;

// Durable session settings are explicit for both newly created helpers and cold
// resumes; legacy grants never acquire full access through a package upgrade.
export function pinHelperPolicy(session, access = 'read-only') {
  session.append('sandbox/mode', { mode: helperAccess(access) === 'full' ? 'danger-full-access' : 'read-only' });
  session.append('approval/policy', { policy: 'never' });
}
