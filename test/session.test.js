import test from "node:test";
import assert from "node:assert/strict";
import { story } from "../src/story-data.js";
import { StorySession, calculateProbabilities, chooseWeightedIndex } from "../src/session.js";

test("beta=1では得票率と抽選確率が一致する", () => {
  const probabilities = calculateProbabilities([6, 3, 1], 1);
  assert.ok(
    probabilities.every((value, index) =>
      Math.abs(value - [0.6, 0.3, 0.1][index]) < 1e-12
    )
  );
});

test("0票の場合は均等な抽選確率になる", () => {
  const probabilities = calculateProbabilities([0, 0, 0], 2);
  assert.ok(probabilities.every((value) => Math.abs(value - 1 / 3) < 1e-12));
});

test("重み付き抽選は境界値に応じた候補を選ぶ", () => {
  assert.equal(chooseWeightedIndex([0.2, 0.3, 0.5], () => 0.1), 0);
  assert.equal(chooseWeightedIndex([0.2, 0.3, 0.5], () => 0.25), 1);
  assert.equal(chooseWeightedIndex([0.2, 0.3, 0.5], () => 0.9), 2);
});

test("参加者は締切まで投票を変更でき、一端末一票になる", () => {
  const session = new StorySession(story);
  session.advance();
  session.advance();
  session.advance();
  session.openVote();
  session.castVote("device-1", "r1-envelope");
  session.castVote("device-1", "r1-cat");
  assert.deepEqual(session.getCounts(), [
    { choiceId: "r1-envelope", count: 0 },
    { choiceId: "r1-cat", count: 1 },
    { choiceId: "r1-message", count: 0 }
  ]);
});

test("投票から抽選、次ラウンドへの遷移が成立する", () => {
  const session = new StorySession(story, () => 0);
  session.advance();
  session.advance();
  session.advance();
  assert.equal(session.phase, "round-ready");

  session.openVote();
  session.castVote("device-1", "r1-envelope");
  session.closeVote();
  const winner = session.draw();
  assert.equal(winner.id, "r1-envelope");
  assert.equal(session.history.length, 1);
  assert.equal(session.phase, "revealed");

  session.advance();
  assert.equal(session.phase, "round-ready");
  assert.equal(session.currentNodeId, "round-2-envelope");
});

test("挙手投票では手入力した票数を使用する", () => {
  const session = new StorySession(story, () => 0.9);
  session.advance();
  session.advance();
  session.advance();
  session.setMode("manual");
  session.openVote();
  session.setManualCounts({ "r1-envelope": 1, "r1-cat": 2, "r1-message": 7 });
  assert.deepEqual(session.getCounts().map((entry) => entry.count), [1, 2, 7]);
});
