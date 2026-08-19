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

const ALLOWED_BETAS = new Set([0.5, 1, 2]);

export function calculateProbabilities(counts, beta) {
  if (!ALLOWED_BETAS.has(beta)) {
    throw new Error("beta must be 0.5, 1, or 2");
  }

  const safeCounts = counts.map((count) => Math.max(0, Number(count) || 0));
  const total = safeCounts.reduce((sum, count) => sum + count, 0);

  if (safeCounts.length === 0) return [];
  if (total === 0) {
    return safeCounts.map(() => 1 / safeCounts.length);
  }

  const weighted = safeCounts.map((count) => (count / total) ** beta);
  const weightedTotal = weighted.reduce((sum, value) => sum + value, 0);
  return weighted.map((value) => value / weightedTotal);
}

export function chooseWeightedIndex(probabilities, random = Math.random) {
  const value = random();
  let cumulative = 0;

  for (let index = 0; index < probabilities.length; index += 1) {
    cumulative += probabilities[index];
    if (value < cumulative || index === probabilities.length - 1) return index;
  }

  return probabilities.length - 1;
}

export class StorySession {
  constructor(story, random = Math.random) {
    this.story = story;
    this.random = random;
    this.reset();
  }

  reset() {
    this.phase = "waiting";
    this.currentNodeId = null;
    this.history = [];
    this.votes = new Map();
    this.manualCounts = new Map();
    this.beta = 1;
    this.mode = "online";
    this.lastDraw = null;
    this.updatedAt = new Date().toISOString();
  }

  get currentNode() {
    return this.currentNodeId ? this.story.nodes[this.currentNodeId] : null;
  }

  touch() {
    this.updatedAt = new Date().toISOString();
  }

  assertPhase(...allowed) {
    if (!allowed.includes(this.phase)) {
      throw new Error(`phase ${this.phase} does not allow this operation`);
    }
  }

  advance() {
    if (this.phase === "waiting") {
      this.phase = "intro";
    } else if (this.phase === "intro") {
      this.phase = "token-demo";
    } else if (this.phase === "token-demo") {
      this.currentNodeId = this.story.startNodeId;
      this.phase = "round-ready";
    } else if (this.phase === "revealed") {
      const winningChoice = this.currentNode?.choices.find(
        (choice) => choice.id === this.lastDraw?.choiceId
      );
      if (!winningChoice) throw new Error("winning choice is missing");

      if (winningChoice.nextNodeId) {
        this.currentNodeId = winningChoice.nextNodeId;
        this.phase = "round-ready";
        this.votes.clear();
        this.manualCounts.clear();
        this.lastDraw = null;
      } else {
        this.phase = "finished";
      }
    } else {
      throw new Error(`phase ${this.phase} cannot advance`);
    }
    this.touch();
  }

  openVote() {
    this.assertPhase("round-ready");
    this.votes.clear();
    this.manualCounts.clear();
    this.lastDraw = null;
    this.phase = "voting";
    this.touch();
  }

  castVote(participantId, choiceId) {
    this.assertPhase("voting");
    if (this.mode !== "online") throw new Error("online voting is disabled");
    if (!participantId || typeof participantId !== "string") {
      throw new Error("participantId is required");
    }
    if (!this.currentNode?.choices.some((choice) => choice.id === choiceId)) {
      throw new Error("invalid choice");
    }
    this.votes.set(participantId, choiceId);
    this.touch();
  }

  setManualCounts(countsByChoice) {
    this.assertPhase("voting", "closed");
    if (this.mode !== "manual") throw new Error("manual mode is disabled");

    for (const choice of this.currentNode?.choices ?? []) {
      const raw = Number(countsByChoice[choice.id] ?? 0);
      if (!Number.isInteger(raw) || raw < 0 || raw > 999) {
        throw new Error("manual counts must be integers from 0 to 999");
      }
      this.manualCounts.set(choice.id, raw);
    }
    this.touch();
  }

  closeVote() {
    this.assertPhase("voting");
    this.phase = "closed";
    this.touch();
  }

  draw() {
    this.assertPhase("closed");
    const choices = this.currentNode?.choices ?? [];
    const counts = this.getCounts().map((entry) => entry.count);
    const probabilities = calculateProbabilities(counts, this.beta);
    const winningIndex = chooseWeightedIndex(probabilities, this.random);
    const winner = choices[winningIndex];

    this.lastDraw = {
      choiceId: winner.id,
      probabilities: Object.fromEntries(
        choices.map((choice, index) => [choice.id, probabilities[index]])
      ),
      usedUniformFallback: counts.every((count) => count === 0)
    };
    this.history.push({
      round: this.currentNode.round,
      nodeId: this.currentNode.id,
      choiceId: winner.id,
      text: winner.text
    });
    this.phase = "revealed";
    this.touch();
    return winner;
  }

  setBeta(beta) {
    const value = Number(beta);
    if (!ALLOWED_BETAS.has(value)) throw new Error("invalid beta");
    this.beta = value;
    this.touch();
  }

  setMode(mode) {
    if (!new Set(["online", "manual"]).has(mode)) throw new Error("invalid mode");
    if (!["waiting", "intro", "token-demo", "round-ready", "voting"].includes(this.phase)) {
      throw new Error("mode cannot be changed after voting closes");
    }
    this.mode = mode;
    this.votes.clear();
    this.manualCounts.clear();
    this.touch();
  }

  getCounts() {
    const choices = this.currentNode?.choices ?? [];
    if (this.mode === "manual") {
      return choices.map((choice) => ({
        choiceId: choice.id,
        count: this.manualCounts.get(choice.id) ?? 0
      }));
    }

    return choices.map((choice) => ({
      choiceId: choice.id,
      count: [...this.votes.values()].filter((value) => value === choice.id).length
    }));
  }

  getPublicState(connectedParticipants = 0) {
    if (!PHASES.has(this.phase)) throw new Error("invalid phase");
    const counts = this.getCounts();
    const totalVotes = counts.reduce((sum, entry) => sum + entry.count, 0);
    const probabilityValues = this.currentNode
      ? calculateProbabilities(
          counts.map((entry) => entry.count),
          this.beta
        )
      : [];

    return {
      story: {
        id: this.story.id,
        title: this.story.title,
        opening: this.story.opening,
        tokenDemo: this.story.tokenDemo
      },
      phase: this.phase,
      mode: this.mode,
      beta: this.beta,
      currentNode: this.currentNode,
      history: this.history,
      storyText: [this.story.opening, ...this.history.map((item) => item.text)].join(" "),
      counts,
      totalVotes,
      probabilities: Object.fromEntries(
        (this.currentNode?.choices ?? []).map((choice, index) => [
          choice.id,
          probabilityValues[index]
        ])
      ),
      lastDraw: this.lastDraw,
      connectedParticipants,
      updatedAt: this.updatedAt
    };
  }
}

