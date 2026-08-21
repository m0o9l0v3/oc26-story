import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

// Version 2 adds the finalized tally for revealed rounds. It is deliberately
// separate from individual votes, which are never persisted.
export const SNAPSHOT_SCHEMA_VERSION = 2;
const LEGACY_SNAPSHOT_SCHEMA_VERSION = 1;
const PROBABILITY_EPSILON = 1e-9;

const PHASES = new Set([
  "waiting",
  "intro",
  "token-demo",
  "round-ready",
  "voting",
  "closed",
  "revealed",
  "finished"
]);

const MODES = new Set(["online", "manual"]);
const BETAS = new Set([0.5, 1, 2]);
const INCOMPLETE_VOTING_PHASES = new Set(["voting", "closed"]);

/**
 * Error raised when a caller asks the store to persist a snapshot that cannot
 * safely be restored later.
 */
export class SnapshotValidationError extends Error {
  constructor(errors) {
    super(`Invalid session snapshot: ${errors.map((error) => error.message).join("; ")}`);
    this.name = "SnapshotValidationError";
    this.code = "INVALID_SNAPSHOT";
    this.errors = errors;
  }
}

function issue(code, message) {
  return { code, message };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validChoiceForNode(story, nodeId, choiceId) {
  return Boolean(story.nodes[nodeId]?.choices.some((choice) => choice.id === choiceId));
}

function expectedProbabilities(counts, beta) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return counts.map(() => 1 / counts.length);
  const weighted = counts.map((count) => (count / total) ** beta);
  const weightedTotal = weighted.reduce((sum, value) => sum + value, 0);
  return weighted.map((value) => value / weightedTotal);
}

/**
 * Validates the versioned, serializable state used for process recovery.
 *
 * Votes deliberately are not part of this schema.  A restart in the middle of
 * a vote must cause a re-vote rather than preserve a potentially partial tally.
 *
 * @param {unknown} snapshot Candidate JSON value.
 * @param {{ story: { id: string, nodes: Record<string, { choices: Array<{ id: string }> }> }, schemaVersion?: number }} options
 * @returns {{ valid: boolean, errors: Array<{ code: string, message: string }> }}
 */
export function validateSnapshot(snapshot, { story, schemaVersion = SNAPSHOT_SCHEMA_VERSION }) {
  const errors = [];

  if (!isPlainObject(snapshot)) {
    return { valid: false, errors: [issue("INVALID_SHAPE", "スナップショットがJSONオブジェクトではありません。")] };
  }

  if (!story || typeof story.id !== "string" || !isPlainObject(story.nodes)) {
    throw new TypeError("story must provide an id and nodes");
  }

  if (snapshot.schemaVersion !== schemaVersion) {
    errors.push(issue("SCHEMA_VERSION_MISMATCH", "スナップショットの形式バージョンが一致しません。"));
  }
  if (snapshot.storyId !== story.id) {
    errors.push(issue("STORY_ID_MISMATCH", "別の物語用のスナップショットです。"));
  }
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    errors.push(issue("INVALID_REVISION", "revision は0以上の整数である必要があります。"));
  }
  if (snapshot.operatorRevision !== undefined && (
    !Number.isSafeInteger(snapshot.operatorRevision)
    || snapshot.operatorRevision < 0
    || snapshot.operatorRevision > snapshot.revision
  )) {
    errors.push(issue(
      "INVALID_OPERATOR_REVISION",
      "operatorRevision はrevision以下の0以上の整数である必要があります。"
    ));
  }
  if (!PHASES.has(snapshot.phase)) {
    errors.push(issue("INVALID_PHASE", "phase が不正です。"));
  }
  if (snapshot.currentNodeId !== null && typeof snapshot.currentNodeId !== "string") {
    errors.push(issue("INVALID_NODE_ID", "currentNodeId が不正です。"));
  } else if (typeof snapshot.currentNodeId === "string" && !story.nodes[snapshot.currentNodeId]) {
    errors.push(issue("UNKNOWN_NODE_ID", "currentNodeId が物語内に存在しません。"));
  }
  if (["round-ready", "voting", "closed", "revealed", "finished"].includes(snapshot.phase) && !snapshot.currentNodeId) {
    errors.push(issue("MISSING_CURRENT_NODE", "このphaseでは currentNodeId が必要です。"));
  }
  if (!Array.isArray(snapshot.history)) {
    errors.push(issue("INVALID_HISTORY", "history は配列である必要があります。"));
  } else {
    snapshot.history.forEach((entry, index) => {
      if (!isPlainObject(entry) || typeof entry.nodeId !== "string" || typeof entry.choiceId !== "string") {
        errors.push(issue("INVALID_HISTORY_ENTRY", `history[${index}] が不正です。`));
        return;
      }
      if (!story.nodes[entry.nodeId] || !validChoiceForNode(story, entry.nodeId, entry.choiceId)) {
        errors.push(issue("INVALID_HISTORY_ENTRY", `history[${index}] が物語データと一致しません。`));
      }
    });
  }
  if (!BETAS.has(snapshot.beta)) {
    errors.push(issue("INVALID_BETA", "beta が不正です。"));
  }
  if (!MODES.has(snapshot.mode)) {
    errors.push(issue("INVALID_MODE", "mode が不正です。"));
  }
  if (snapshot.lastDraw !== null && !isPlainObject(snapshot.lastDraw)) {
    errors.push(issue("INVALID_LAST_DRAW", "lastDraw が不正です。"));
  } else if (isPlainObject(snapshot.lastDraw)) {
    if (typeof snapshot.currentNodeId !== "string" || typeof snapshot.lastDraw.choiceId !== "string" || !validChoiceForNode(story, snapshot.currentNodeId, snapshot.lastDraw.choiceId)) {
      errors.push(issue("INVALID_LAST_DRAW", "lastDraw が現在の選択肢と一致しません。"));
    }
    const choices = story.nodes[snapshot.currentNodeId]?.choices ?? [];
    let finalizedCounts = null;
    if (!Array.isArray(snapshot.lastDraw.counts)) {
      errors.push(issue("INVALID_FINAL_COUNTS", "確定した票数が保存されていません。"));
    } else {
      const countsByChoice = new Map();
      for (const entry of snapshot.lastDraw.counts) {
        if (!isPlainObject(entry) || typeof entry.choiceId !== "string" || !Number.isSafeInteger(entry.count) || entry.count < 0) {
          errors.push(issue("INVALID_FINAL_COUNTS", "確定した票数の形式が不正です。"));
          continue;
        }
        if (!validChoiceForNode(story, snapshot.currentNodeId, entry.choiceId) || countsByChoice.has(entry.choiceId)) {
          errors.push(issue("INVALID_FINAL_COUNTS", "確定した票数の選択肢が不正です。"));
          continue;
        }
        countsByChoice.set(entry.choiceId, entry.count);
      }
      if (countsByChoice.size !== choices.length || choices.some((choice) => !countsByChoice.has(choice.id))) {
        errors.push(issue("INVALID_FINAL_COUNTS", "確定した票数に不足または重複があります。"));
      } else {
        finalizedCounts = choices.map((choice) => countsByChoice.get(choice.id));
        const total = finalizedCounts.reduce((sum, count) => sum + count, 0);
        if (!Number.isSafeInteger(total)) {
          errors.push(issue("INVALID_FINAL_COUNTS", "確定した票数の合計が大きすぎます。"));
          finalizedCounts = null;
        }
      }
    }

    if (!isPlainObject(snapshot.lastDraw.probabilities)) {
      errors.push(issue("INVALID_LAST_DRAW", "確定した抽選確率が保存されていません。"));
    } else {
      const probabilityKeys = Object.keys(snapshot.lastDraw.probabilities);
      const probabilities = choices.map((choice) => snapshot.lastDraw.probabilities[choice.id]);
      const hasExactChoiceSet = probabilityKeys.length === choices.length
        && choices.every((choice) => Object.hasOwn(snapshot.lastDraw.probabilities, choice.id));
      const hasValidValues = probabilities.every(
        (probability) => typeof probability === "number"
          && Number.isFinite(probability)
          && probability >= 0
          && probability <= 1
      );
      if (!hasExactChoiceSet || !hasValidValues) {
        errors.push(issue("INVALID_LAST_DRAW", "確定した抽選確率の形式が不正です。"));
      } else if (Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) > PROBABILITY_EPSILON) {
        errors.push(issue("INVALID_LAST_DRAW", "確定した抽選確率の合計が1ではありません。"));
      } else if (finalizedCounts) {
        const expected = expectedProbabilities(finalizedCounts, snapshot.beta);
        if (probabilities.some((probability, index) => Math.abs(probability - expected[index]) > PROBABILITY_EPSILON)) {
          errors.push(issue("INVALID_LAST_DRAW", "確定した票数と抽選確率が一致しません。"));
        }
        const winnerIndex = choices.findIndex((choice) => choice.id === snapshot.lastDraw.choiceId);
        if (winnerIndex >= 0 && probabilities[winnerIndex] <= 0) {
          errors.push(issue("INVALID_LAST_DRAW", "得票確率が0の選択肢を抽選結果にはできません。"));
        }
      }
    }
    if (typeof snapshot.lastDraw.usedUniformFallback !== "boolean") {
      errors.push(issue("INVALID_LAST_DRAW", "0票時の抽選方式が不正です。"));
    } else if (finalizedCounts && snapshot.lastDraw.usedUniformFallback !== finalizedCounts.every((count) => count === 0)) {
      errors.push(issue("INVALID_LAST_DRAW", "0票時の抽選方式と確定票数が一致しません。"));
    }
    const finalHistoryEntry = Array.isArray(snapshot.history) ? snapshot.history.at(-1) : null;
    if (["revealed", "finished"].includes(snapshot.phase)
      && (finalHistoryEntry?.nodeId !== snapshot.currentNodeId
        || finalHistoryEntry?.choiceId !== snapshot.lastDraw.choiceId)) {
      errors.push(issue("INVALID_LAST_DRAW", "確定した抽選結果が物語履歴と一致しません。"));
    }
  }
  if (["revealed", "finished"].includes(snapshot.phase) && snapshot.lastDraw === null) {
    errors.push(issue("MISSING_LAST_DRAW", "このphaseでは確定した抽選結果が必要です。"));
  }
  if (!["revealed", "finished"].includes(snapshot.phase) && snapshot.lastDraw !== null) {
    errors.push(issue("UNEXPECTED_LAST_DRAW", "このphaseでは確定した抽選結果を保持できません。"));
  }
  if (!isValidTimestamp(snapshot.updatedAt)) {
    errors.push(issue("INVALID_UPDATED_AT", "updatedAt がISO日時ではありません。"));
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Migrates a schema-v1 file into a state that schema v2 can represent safely.
 * V1 did not persist finalized counts, so a revealed/final result cannot be
 * reconstructed without inventing a tally. Roll that one result back and let
 * the operator replay the round instead.
 */
function migrateSnapshotForLoad(snapshot, story) {
  if (!isPlainObject(snapshot) || snapshot.schemaVersion !== LEGACY_SNAPSHOT_SCHEMA_VERSION) {
    return { snapshot, resetLegacyResult: false, errors: [] };
  }

  const resultPhase = ["revealed", "finished"].includes(snapshot.phase);
  if (resultPhase) {
    const lastHistoryEntry = Array.isArray(snapshot.history) ? snapshot.history.at(-1) : null;
    if (!isPlainObject(snapshot.lastDraw)
      || !validChoiceForNode(story, snapshot.currentNodeId, snapshot.lastDraw.choiceId)
      || lastHistoryEntry?.nodeId !== snapshot.currentNodeId
      || lastHistoryEntry?.choiceId !== snapshot.lastDraw.choiceId) {
      return {
        snapshot,
        resetLegacyResult: false,
        errors: [issue("INVALID_LAST_DRAW", "旧形式の抽選結果が物語履歴と一致しません。")]
      };
    }
  }

  const migrated = {
    ...structuredClone(snapshot),
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    operatorRevision: snapshot.revision
  };
  if (resultPhase) {
    migrated.phase = "round-ready";
    migrated.history = migrated.history.slice(0, -1);
    migrated.lastDraw = null;
  }

  return { snapshot: migrated, resetLegacyResult: resultPhase, errors: [] };
}

/**
 * Produces the safe in-memory state to use after loading a valid snapshot.
 * Incomplete online or manual voting is reset because individual votes are not
 * persisted by design.
 *
 * @param {Record<string, unknown>} snapshot A validated snapshot.
 * @returns {{ snapshot: Record<string, unknown>, resetIncompleteVote: boolean }}
 */
export function prepareSnapshotForRecovery(snapshot) {
  const recovered = structuredClone(snapshot);
  const resetIncompleteVote = INCOMPLETE_VOTING_PHASES.has(recovered.phase);

  if (resetIncompleteVote) {
    recovered.phase = "round-ready";
    recovered.lastDraw = null;
  }

  return { snapshot: recovered, resetIncompleteVote };
}

/**
 * Stores one current state and one previous generation on local disk.
 *
 * `save` first writes and syncs a temporary file, then atomically renames it
 * into place. Before that final rename, a validated current file is copied to
 * an atomic previous-generation file. A damaged current file is never promoted
 * over a known-good previous generation. A process crash can therefore leave an
 * older but complete current or previous file, never a partially written one.
 */
export class SnapshotStore {
  /**
   * @param {{ directory: string, story: { id: string, nodes: Record<string, { choices: Array<{ id: string }> }> }, schemaVersion?: number, fileName?: string }} options
   */
  constructor({ directory, story, schemaVersion = SNAPSHOT_SCHEMA_VERSION, fileName = "session-state.json" }) {
    if (!directory || typeof directory !== "string") throw new TypeError("directory is required");
    if (!fileName || path.basename(fileName) !== fileName) {
      throw new TypeError("fileName must be a file name without a directory");
    }
    // Validate the configuration early, before attempting any disk access.
    validateSnapshot(
      {
        schemaVersion,
        storyId: story?.id,
        revision: 0,
        phase: "waiting",
        currentNodeId: null,
        history: [],
        beta: 1,
        mode: "online",
        lastDraw: null,
        updatedAt: new Date(0).toISOString()
      },
      { story, schemaVersion }
    );

    const extension = path.extname(fileName);
    const baseName = extension ? fileName.slice(0, -extension.length) : fileName;
    this.directory = directory;
    this.story = story;
    this.schemaVersion = schemaVersion;
    this.paths = Object.freeze({
      current: path.join(directory, fileName),
      previous: path.join(directory, `${baseName}.previous${extension}`),
      temporary: path.join(directory, `${baseName}.tmp${extension}`),
      previousTemporary: path.join(directory, `${baseName}.previous.tmp${extension}`)
    });
  }

  /**
   * Validates and atomically saves a snapshot.
   *
   * @param {Record<string, unknown>} snapshot
   * @returns {Promise<void>}
   * @throws {SnapshotValidationError} when the snapshot is not restorable.
   */
  async save(snapshot) {
    const validation = validateSnapshot(snapshot, this);
    if (!validation.valid) throw new SnapshotValidationError(validation.errors);

    const serialized = `${JSON.stringify(snapshot)}\n`;
    await mkdir(this.directory, { recursive: true });
    await writeAndSync(this.paths.temporary, serialized);

    // Only rotate a restorable current file. After a startup recovered from
    // `previous`, the old current file may still be damaged until this save
    // completes. Rotating that file would destroy the only known-good backup
    // if the process crashed between the two renames.
    const current = await this.#readCandidate(this.paths.current, "current");
    if (current.kind === "valid") {
      await copyFile(this.paths.current, this.paths.previousTemporary);
      await rename(this.paths.previousTemporary, this.paths.previous);
    }

    await rename(this.paths.temporary, this.paths.current);
  }

  /** Verifies that the configured directory supports the same write/sync/rename operations used by save(). */
  async probe() {
    await mkdir(this.directory, { recursive: true });
    const probe = path.join(this.directory, `.oc26-write-probe-${process.pid}`);
    const renamed = `${probe}.ready`;
    try {
      await writeAndSync(probe, "ok\n");
      await rename(probe, renamed);
    } finally {
      await unlink(probe).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      await unlink(renamed).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  /**
   * Loads the current snapshot, falling back to one previous generation when
   * the current file is unreadable, malformed, or fails validation.
   *
   * @returns {Promise<{
   *   status: "restored" | "empty" | "unrecoverable",
   *   source: "current" | "previous" | null,
   *   snapshot: Record<string, unknown> | null,
   *   resetIncompleteVote: boolean,
   *   issues: Array<{ source: "current" | "previous", code: string, message: string }>
   * }>}
   */
  async load() {
    const issues = [];
    let foundCandidate = false;

    for (const [source, filePath] of [
      ["current", this.paths.current],
      ["previous", this.paths.previous]
    ]) {
      const candidate = await this.#readCandidate(filePath, source);
      if (candidate.kind === "missing") continue;
      foundCandidate = true;
      if (candidate.kind === "invalid") {
        issues.push(...candidate.issues);
        continue;
      }

      const recovered = prepareSnapshotForRecovery(candidate.snapshot);
      return {
        status: "restored",
        source,
        snapshot: recovered.snapshot,
        resetIncompleteVote: candidate.resetLegacyResult || recovered.resetIncompleteVote,
        issues
      };
    }

    return {
      status: foundCandidate ? "unrecoverable" : "empty",
      source: null,
      snapshot: null,
      resetIncompleteVote: false,
      issues
    };
  }

  async #readCandidate(filePath, source) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return { kind: "missing" };
      return {
        kind: "invalid",
        issues: [
          {
            source,
            code: error instanceof SyntaxError ? "INVALID_JSON" : "UNREADABLE_SNAPSHOT",
            message:
              error instanceof SyntaxError
                ? "スナップショットJSONを読み込めません。"
                : "スナップショットファイルを読み込めません。"
          }
        ]
      };
    }

    const migration = migrateSnapshotForLoad(parsed, this.story);
    if (migration.errors.length > 0) {
      return {
        kind: "invalid",
        issues: migration.errors.map((error) => ({ ...error, source }))
      };
    }

    const validation = validateSnapshot(migration.snapshot, this);
    if (!validation.valid) {
      return {
        kind: "invalid",
        issues: validation.errors.map((error) => ({ ...error, source }))
      };
    }
    return {
      kind: "valid",
      snapshot: migration.snapshot,
      resetLegacyResult: migration.resetLegacyResult
    };
  }
}

async function writeAndSync(filePath, contents) {
  const handle = await open(filePath, "w", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
