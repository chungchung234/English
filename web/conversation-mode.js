// The stored marker selects a voice mode; it is never user-facing copy.
export const MIA_ROLEPLAY_SCENARIO = 'Mia voice roleplay v1 — scene supplied during the call';

export function isMiaRoleplaySession(session) {
  return session?.companion_id === 'mia' && session.scenario === MIA_ROLEPLAY_SCENARIO;
}

export function scenarioLabel(session) {
  return isMiaRoleplaySession(session) ? '역할극' : session?.scenario || '';
}
