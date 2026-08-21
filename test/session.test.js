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

test("参加者の投票は運営操作用revisionを変更しない", () => {
  const session = new StorySession(story);
  session.advance();
  session.advance();
  session.advance();
  session.openVote();
  const beforeVote = {
    revision: session.revision,
    operatorRevision: session.operatorRevision
  };

  session.castVote("device-1", "r1-envelope");

  assert.equal(session.revision, beforeVote.revision + 1);
  assert.equal(session.operatorRevision, beforeVote.operatorRevision);
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

test("不正な挙手数が混ざっても途中までの値を反映しない", () => {
  const session = new StorySession(story);
  session.advance();
  session.advance();
  session.advance();
  session.setMode("manual");
  session.openVote();
  session.setManualCounts({ "r1-envelope": 1, "r1-cat": 2, "r1-message": 3 });
  const before = session.getCounts();

  assert.throws(
    () => session.setManualCounts({ "r1-envelope": 99, "r1-cat": -1, "r1-message": 0 }),
    /manual counts/
  );
  assert.deepEqual(session.getCounts(), before);
});

test("確定後の票数と抽選確率を個別票なしでスナップショット化し復元できる", () => {
  const original = new StorySession(story, () => 0);
  original.advance();
  original.advance();
  original.advance();
  original.openVote();
  original.castVote("participant-a", "r1-envelope");
  original.castVote("participant-b", "r1-envelope");
  original.castVote("participant-c", "r1-cat");
  original.closeVote();
  original.draw();

  const snapshot = original.createSnapshot();
  assert.equal("votes" in snapshot, false);
  assert.equal(snapshot.history.length, 1);
  assert.deepEqual(snapshot.lastDraw.counts, [
    { choiceId: "r1-envelope", count: 2 },
    { choiceId: "r1-cat", count: 1 },
    { choiceId: "r1-message", count: 0 }
  ]);

  const restored = new StorySession(story);
  restored.restoreSnapshot(snapshot);
  assert.equal(restored.phase, "revealed");
  assert.deepEqual(restored.history, original.history);
  assert.deepEqual(restored.getPublicState().counts, original.getPublicState().counts);
  assert.deepEqual(restored.getPublicState().probabilities, original.getPublicState().probabilities);
  assert.equal(restored.getPublicState().totalVotes, 3);
  assert.match(restored.recoveryNotice, /復元/);
});

test("投票途中からの復元通知を運営状態へ含める", () => {
  const session = new StorySession(story);
  session.restoreSnapshot(
    {
      schemaVersion: 1,
      storyId: story.id,
      revision: 8,
      phase: "round-ready",
      currentNodeId: "round-1",
      history: [],
      beta: 1,
      mode: "online",
      lastDraw: null,
      updatedAt: "2026-08-20T00:00:00.000Z"
    },
    { resetIncompleteVote: true }
  );

  const state = session.getPublicState();
  assert.equal(state.revision, 8);
  assert.match(state.recoveryNotice, /もう一度投票/);
});

test("投票開始後の通常方式変更を拒否し、緊急切り替えだけを許可する", () => {
  const session = new StorySession(story);
  session.advance();
  session.advance();
  session.advance();
  session.openVote();
  session.castVote("participant-a", "r1-envelope");

  assert.throws(() => session.setMode("manual"), /緊急切り替え/);
  session.switchToManualEmergency();
  assert.equal(session.mode, "manual");
  assert.equal(session.getCounts().every((entry) => entry.count === 0), true);
});
