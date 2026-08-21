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
  revision: 7,
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
    revision: fullState.revision,
    updatedAt: fullState.updatedAt
  });
});

test("support projection contains only non-sensitive operational state", () => {
  assert.deepEqual(projectStateForRole(fullState, "support"), {
    phase: fullState.phase,
    mode: fullState.mode,
    connectedParticipants: fullState.connectedParticipants,
    revision: fullState.revision,
    updatedAt: fullState.updatedAt
  });
});

test("display hides candidate tallies while voting and operator retains full state", () => {
  const display = projectStateForRole(fullState, "display");
  for (const field of ["counts", "probabilities", "lastDraw", "beta", "mode"]) {
    assert.equal(field in display, false, field);
  }
  assert.equal(display.totalVotes, fullState.totalVotes);
  assert.equal(projectStateForRole(fullState, "operator"), fullState);
});

test("missing role is participant and invalid roles are rejected", () => {
  assert.equal(resolveStateRole(null), "participant");
  assert.throws(() => resolveStateRole("unknown"), /invalid state role/);
});
