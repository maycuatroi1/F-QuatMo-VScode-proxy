import type { StudentSessionState } from "../../services/sessionStore";

export function hasSessionParticipation(state: StudentSessionState | undefined): boolean {
  return !!state && (state.hasLoggedIn || state.loginTimestamp > 0);
}

