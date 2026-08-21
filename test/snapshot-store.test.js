import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { story } from "../src/story-data.js";
import {
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotStore,
  SnapshotValidationError,
  validateSnapshot
} from "../src/infrastructure/snapshot-store.js";

async function withStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oc26-snapshot-store-"));
  const store = new SnapshotStore({ directory, story });
  try {
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    storyId: story.id,
    revision: 12,
    phase: "round-ready",
    currentNodeId: "round-1",
    history: [],
    beta: 1,
    mode: "online",
    lastDraw: null,
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides
  };
}

test("正常なスナップショットを原子的に保存して復元できる", async () => {
  await withStore(async (store) => {
    const saved = snapshot();
    await store.save(saved);

    const restored = await store.load();
    assert.equal(restored.status, "restored");
    assert.equal(restored.source, "current");
    assert.deepEqual(restored.snapshot, saved);
    assert.equal(restored.resetIncompleteVote, false);
    assert.deepEqual(restored.issues, []);
    assert.equal(await readFile(store.paths.current, "utf8"), `${JSON.stringify(saved)}\n`);
    await assert.rejects(readFile(store.paths.temporary), { code: "ENOENT" });
  });
});

test("保存時に現在世代をpreviousとして1世代だけ保持する", async () => {
  await withStore(async (store) => {
    const first = snapshot({ revision: 1 });
    const second = snapshot({ revision: 2, beta: 2 });
    await store.save(first);
    await store.save(second);

    assert.deepEqual(JSON.parse(await readFile(store.paths.current, "utf8")), second);
    assert.deepEqual(JSON.parse(await readFile(store.paths.previous, "utf8")), first);
  });
});

test("現在ファイルが破損していてもprevious世代から復元できる", async () => {
  await withStore(async (store) => {
    const previous = snapshot({ revision: 1 });
    await store.save(previous);
    await store.save(snapshot({ revision: 2 }));
    await writeFile(store.paths.current, "{broken JSON", "utf8");

    const restored = await store.load();
    assert.equal(restored.status, "restored");
    assert.equal(restored.source, "previous");
    assert.deepEqual(restored.snapshot, previous);
    assert.deepEqual(restored.issues, [
      { source: "current", code: "INVALID_JSON", message: "スナップショットJSONを読み込めません。" }
    ]);
  });
});

test("投票中または締切後の復元では安全にround-readyへ戻す", async () => {
  await withStore(async (store) => {
    for (const phase of ["voting", "closed"]) {
      await store.save(snapshot({ phase, mode: "manual" }));

      const restored = await store.load();
      assert.equal(restored.status, "restored");
      assert.equal(restored.resetIncompleteVote, true);
      assert.equal(restored.snapshot.phase, "round-ready");
      assert.equal(restored.snapshot.lastDraw, null);
    }
  });
});

test("schemaVersionまたはstoryIdの不一致を保存・復元時に拒否する", async () => {
  await withStore(async (store) => {
    const wrongVersion = snapshot({ schemaVersion: 99 });
    const wrongStory = snapshot({ storyId: "another-story" });

    assert.equal(validateSnapshot(wrongVersion, { story }).errors[0].code, "SCHEMA_VERSION_MISMATCH");
    assert.equal(validateSnapshot(wrongStory, { story }).errors[0].code, "STORY_ID_MISMATCH");
    await assert.rejects(store.save(wrongVersion), SnapshotValidationError);
    await writeFile(store.paths.current, JSON.stringify(wrongStory), "utf8");

    const restored = await store.load();
    assert.equal(restored.status, "unrecoverable");
    assert.equal(restored.snapshot, null);
    assert.deepEqual(restored.issues, [
      { source: "current", code: "STORY_ID_MISMATCH", message: "別の物語用のスナップショットです。" }
    ]);
  });
});

test("現在・previousの両方が無効ならunrecoverableを明示する", async () => {
  await withStore(async (store) => {
    await writeFile(store.paths.current, "not json", "utf8");
    await writeFile(store.paths.previous, JSON.stringify(snapshot({ phase: "unknown" })), "utf8");

    const restored = await store.load();
    assert.equal(restored.status, "unrecoverable");
    assert.equal(restored.source, null);
    assert.equal(restored.snapshot, null);
    assert.equal(restored.issues.length, 2);
    assert.deepEqual(
      restored.issues.map((entry) => [entry.source, entry.code]),
      [
        ["current", "INVALID_JSON"],
        ["previous", "INVALID_PHASE"]
      ]
    );
  });
});

test("保存ファイルがない初回起動はemptyを返す", async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.load(), {
      status: "empty",
      source: null,
      snapshot: null,
      resetIncompleteVote: false,
      issues: []
    });
  });
});
