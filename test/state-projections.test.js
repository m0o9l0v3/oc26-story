import test from "node:test";
import assert from "node:assert/strict";
import { projectStateForRole, resolveStateRole } from "../src/application/state-projections.js";

const fullState = {
  story: { id: "story" },
  phase: "voting",
  currentNode: { id: "round-1" },
  history: [],
  storyText: "opening",
  connectedParticipants: 3,
  updatedAt: "2026-08-20T00:00:00.000Z",
  counts: [{ choiceId: "a", count: 2 }],
  totalVotes: 2,
  probabilities: { a: 1 },
  lastDraw: { choiceId: "a" },
  mode: "online",
  beta: 1
};

test("participant projection uses a strict allow-list", () => {
  const participant = projectStateForRole(fullState, "participant");
  assert.deepEqual(participant, {
    story: fullState.story,
    phase: fullState.phase,
    currentNode: fullState.currentNode,
    history: fullState.history,
    storyText: fullState.storyText,
    connectedParticipants: fullState.connectedParticipants,
    updatedAt: fullState.updatedAt
  });
});

test("display and operator projections retain aggregate state", () => {
  assert.equal(projectStateForRole(fullState, "display"), fullState);
  assert.equal(projectStateForRole(fullState, "operator"), fullState);
});

test("missing role is participant and invalid roles are rejected", () => {
  assert.equal(resolveStateRole(null), "participant");
  assert.throws(() => resolveStateRole("unknown"), /invalid state role/);
});
