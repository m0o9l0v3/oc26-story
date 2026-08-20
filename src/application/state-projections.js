const ROLES = new Set(["participant", "display", "operator"]);

/**
 * Parses the externally supplied presentation role. Missing roles are treated
 * as participant so an unlabelled request never receives live vote data.
 */
export function resolveStateRole(value) {
  if (value === null || value === undefined || value === "") return "participant";
  if (!ROLES.has(value)) throw new Error("invalid state role");
  return value;
}

/**
 * Returns the state appropriate for a presentation role.
 *
 * The participant projection is deliberately an allow-list. This avoids
 * accidentally exposing a new operational field when the full state grows.
 */
export function projectStateForRole(fullState, role) {
  switch (role) {
    case "participant":
      return {
        story: fullState.story,
        phase: fullState.phase,
        currentNode: fullState.currentNode,
        history: fullState.history,
        storyText: fullState.storyText,
        connectedParticipants: fullState.connectedParticipants,
        updatedAt: fullState.updatedAt
      };
    case "display":
    case "operator":
      // The display intentionally keeps the established aggregate fields.
      // The operator receives the complete API state as well.
      return fullState;
    default:
      throw new Error("invalid state role");
  }
}
