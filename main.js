const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

const statsEl = document.getElementById("stats");
const readoutEl = document.getElementById("readout");
const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const resetButton = document.getElementById("reset");

const GRID_W = 50;
const GRID_H = 40;
const CELL = 5;
const MAX_FOOD = 12;
const TREE_COUNT = 80;
const ROCK_COUNT = 55;
const PREDATOR_COUNT = 3;
const LOGIC_RATE = 10; // updates per second

const COLORS = {
  water: "#2b5d99",
  land: "#5bb450",
  sand: "#c7a45a",
  tree: "#2a9d4b",
  rock: "#9aa3ad",
  food: "#fcbf49",
  ape: "#7b4d2d",
  predator: "#d62828",
  outline: "#183049",
};

const ACTIONS = [
  { name: "stay", dx: 0, dy: 0 },
  { name: "up", dx: 0, dy: -1 },
  { name: "down", dx: 0, dy: 1 },
  { name: "left", dx: -1, dy: 0 },
  { name: "right", dx: 1, dy: 0 },
];

const NET_INPUTS = 5;
const NET_HIDDEN = 16;
const NET_OUTPUTS = ACTIONS.length;
const NET_LR = 0.05;
const NET_GAMMA = 0.9;

const ADVICE_INTENTS = [
  {
    id: "avoidPredator",
    samples: [
      "avoid predators",
      "stay away from predators",
      "run from predators",
      "flee danger",
      "keep distance from predators",
      "hide from predators",
      "keep safe from predators",
      "stay safe",
      "avoid danger",
      "run away",
      "escape predators",
      "stop predators",
      "stop the predators",
    ],
  },
  {
    id: "seekFood",
    samples: [
      "find food",
      "get food",
      "eat now",
      "look for food",
      "search for fruit",
      "forage for food",
      "find something to eat",
      "eat something",
      "grab food",
      "get some fruit",
      "look for berries",
      "feed yourself",
    ],
  },
  {
    id: "seekTrees",
    samples: [
      "stay near trees",
      "go to trees",
      "hide in trees",
      "stick with trees",
      "go to the forest",
      "stay in the forest",
      "stick to the trees",
    ],
  },
  {
    id: "avoidRocks",
    samples: [
      "avoid rocks",
      "stay away from rocks",
      "do not hit rocks",
      "rocks are dangerous",
      "avoid stones",
      "keep away from boulders",
      "do not touch rocks",
    ],
  },
  {
    id: "stay",
    samples: [
      "stay",
      "wait",
      "hold position",
      "do not move",
      "pause here",
      "stay still",
      "hold still",
      "freeze",
    ],
  },
  {
    id: "direction_up",
    samples: ["go north", "head north", "move up", "north", "northward", "go up"],
  },
  {
    id: "direction_down",
    samples: ["go south", "head south", "move down", "south", "southward", "go down"],
  },
  {
    id: "direction_left",
    samples: ["go west", "head west", "move left", "west", "go left"],
  },
  {
    id: "direction_right",
    samples: ["go east", "head east", "move right", "east", "go right"],
  },
];

let terrainCanvas;
let landMask;
let trees = new Set();
let rocks = new Set();
let food = [];
let predators = [];
let ape;
let adviceRules = [];
let adviceId = 1;
let tick = 0;
let adviceModel;

function randInt(max) {
  return Math.floor(Math.random() * max);
}

function key(x, y) {
  return `${x},${y}`;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.abs(dx) + Math.abs(dy);
}

function initNetwork(inputSize, hiddenSize, outputSize) {
  const scale = 0.4;
  const W1 = Array.from({ length: hiddenSize }, () =>
    Array.from({ length: inputSize }, () => (Math.random() * 2 - 1) * scale)
  );
  const b1 = Array(hiddenSize).fill(0);
  const W2 = Array.from({ length: outputSize }, () =>
    Array.from({ length: hiddenSize }, () => (Math.random() * 2 - 1) * scale)
  );
  const b2 = Array(outputSize).fill(0);
  return {
    inputSize,
    hiddenSize,
    outputSize,
    W1,
    b1,
    W2,
    b2,
  };
}

function forwardNetwork(net, inputs) {
  const z1 = net.W1.map((row, i) => {
    let sum = net.b1[i];
    for (let j = 0; j < row.length; j += 1) {
      sum += row[j] * inputs[j];
    }
    return sum;
  });
  const h = z1.map((val) => (val > 0 ? val : 0));
  const q = net.W2.map((row, i) => {
    let sum = net.b2[i];
    for (let j = 0; j < row.length; j += 1) {
      sum += row[j] * h[j];
    }
    return sum;
  });
  return { z1, h, q };
}

function predictQ(net, inputs) {
  return forwardNetwork(net, inputs).q;
}

function trainNetwork(net, inputs, actionIdx, target) {
  const { z1, h, q } = forwardNetwork(net, inputs);
  const error = target - q[actionIdx];

  for (let i = 0; i < net.hiddenSize; i += 1) {
    net.W2[actionIdx][i] += NET_LR * error * h[i];
  }
  net.b2[actionIdx] += NET_LR * error;

  for (let i = 0; i < net.hiddenSize; i += 1) {
    if (z1[i] <= 0) {
      continue;
    }
    const delta = error * net.W2[actionIdx][i];
    for (let j = 0; j < net.inputSize; j += 1) {
      net.W1[i][j] += NET_LR * delta * inputs[j];
    }
    net.b1[i] += NET_LR * delta;
  }
}

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((val) => Math.exp(val - max));
  const sum = exps.reduce((acc, val) => acc + val, 0) || 1;
  return exps.map((val) => val / sum);
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s%]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function vectorizeText(text, vocabIndex, vocabSize) {
  const vector = Array(vocabSize).fill(0);
  const tokens = tokenize(text);
  tokens.forEach((token) => {
    const idx = vocabIndex[token];
    if (idx !== undefined) {
      vector[idx] = 1;
    }
  });
  return vector;
}

function trainTextNet(net, dataset, vocabIndex, vocabSize) {
  const epochs = 220;
  const lr = 0.15;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    dataset.forEach((sample) => {
      const inputs = vectorizeText(sample.text, vocabIndex, vocabSize);
      const { z1, h, q } = forwardNetwork(net, inputs);
      const probs = softmax(q);
      const deltas = probs.map((val, idx) => val - (idx === sample.label ? 1 : 0));

      for (let i = 0; i < net.outputSize; i += 1) {
        for (let j = 0; j < net.hiddenSize; j += 1) {
          net.W2[i][j] -= lr * deltas[i] * h[j];
        }
        net.b2[i] -= lr * deltas[i];
      }

      for (let i = 0; i < net.hiddenSize; i += 1) {
        if (z1[i] <= 0) {
          continue;
        }
        let deltaHidden = 0;
        for (let k = 0; k < net.outputSize; k += 1) {
          deltaHidden += deltas[k] * net.W2[k][i];
        }
        for (let j = 0; j < net.inputSize; j += 1) {
          net.W1[i][j] -= lr * deltaHidden * inputs[j];
        }
        net.b1[i] -= lr * deltaHidden;
      }
    });
  }
}

function buildAdviceModel() {
  const dataset = [];
  const vocab = new Set();
  ADVICE_INTENTS.forEach((intent, idx) => {
    intent.samples.forEach((sample) => {
      dataset.push({ text: sample, label: idx });
      tokenize(sample).forEach((token) => vocab.add(token));
    });
  });
  const vocabList = Array.from(vocab);
  const vocabIndex = {};
  vocabList.forEach((token, idx) => {
    vocabIndex[token] = idx;
  });
  const vocabSize = vocabList.length;
  const net = initNetwork(vocabSize, 12, ADVICE_INTENTS.length);
  trainTextNet(net, dataset, vocabIndex, vocabSize);
  return {
    net,
    vocabIndex,
    vocabSize,
    intents: ADVICE_INTENTS.map((intent) => intent.id),
  };
}

function classifyAdviceAction(text) {
  if (!adviceModel) {
    return { action: null, confidence: 0 };
  }
  const inputs = vectorizeText(text, adviceModel.vocabIndex, adviceModel.vocabSize);
  if (inputs.every((val) => val === 0)) {
    return { action: null, confidence: 0 };
  }
  const { q } = forwardNetwork(adviceModel.net, inputs);
  const probs = softmax(q);
  let bestIdx = 0;
  let bestScore = probs[0];
  for (let i = 1; i < probs.length; i += 1) {
    if (probs[i] > bestScore) {
      bestScore = probs[i];
      bestIdx = i;
    }
  }
  const intentId = adviceModel.intents[bestIdx];
  return { action: intentToAction(intentId), confidence: bestScore };
}

function intentToAction(intentId) {
  if (!intentId) {
    return null;
  }
  if (intentId === "direction_up") {
    return { type: "direction", dir: "up" };
  }
  if (intentId === "direction_down") {
    return { type: "direction", dir: "down" };
  }
  if (intentId === "direction_left") {
    return { type: "direction", dir: "left" };
  }
  if (intentId === "direction_right") {
    return { type: "direction", dir: "right" };
  }
  return { type: intentId };
}

function createLandMask() {
  landMask = [];
  const cx = GRID_W / 2 - 0.5;
  const cy = GRID_H / 2 - 0.5;
  const rx = GRID_W / 2 - 2;
  const ry = GRID_H / 2 - 2;

  for (let y = 0; y < GRID_H; y += 1) {
    const row = [];
    for (let x = 0; x < GRID_W; x += 1) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const inside = nx * nx + ny * ny <= 1;
      row.push(inside);
    }
    landMask.push(row);
  }
}

function drawTerrain() {
  terrainCanvas = document.createElement("canvas");
  terrainCanvas.width = GRID_W * CELL;
  terrainCanvas.height = GRID_H * CELL;
  const tctx = terrainCanvas.getContext("2d");
  tctx.imageSmoothingEnabled = false;

  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      if (landMask[y][x]) {
        const edge = !landMask[y - 1]?.[x] || !landMask[y + 1]?.[x] || !landMask[y]?.[x - 1] || !landMask[y]?.[x + 1];
        tctx.fillStyle = edge ? COLORS.sand : COLORS.land;
      } else {
        tctx.fillStyle = COLORS.water;
      }
      tctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }
}

function isLand(x, y) {
  return landMask[y]?.[x];
}

function isBlocked(x, y) {
  if (!isLand(x, y)) {
    return true;
  }
  return trees.has(key(x, y)) || rocks.has(key(x, y));
}

function randomLandCell() {
  let x = 0;
  let y = 0;
  do {
    x = randInt(GRID_W);
    y = randInt(GRID_H);
  } while (!isLand(x, y) || trees.has(key(x, y)) || rocks.has(key(x, y)));
  return { x, y };
}

function placeFeatures(count, targetSet) {
  let placed = 0;
  while (placed < count) {
    const { x, y } = randomLandCell();
    const k = key(x, y);
    if (!targetSet.has(k)) {
      targetSet.add(k);
      placed += 1;
    }
  }
}

function spawnFood() {
  if (food.length >= MAX_FOOD) {
    return;
  }
  const { x, y } = randomLandCell();
  food.push({ x, y, age: 0 });
}

function seedFood() {
  food = [];
  for (let i = 0; i < MAX_FOOD; i += 1) {
    spawnFood();
  }
}

function spawnPredators() {
  predators = [];
  for (let i = 0; i < PREDATOR_COUNT; i += 1) {
    const { x, y } = randomLandCell();
    predators.push({ x, y, dir: ACTIONS[randInt(ACTIONS.length)] });
  }
}

function hydrateNet(saved) {
  if (!saved || !saved.W1 || !saved.W2) {
    return initNetwork(NET_INPUTS, NET_HIDDEN, NET_OUTPUTS);
  }
  if (
    saved.W1.length !== NET_HIDDEN
    || saved.W1[0]?.length !== NET_INPUTS
    || saved.W2.length !== NET_OUTPUTS
    || saved.W2[0]?.length !== NET_HIDDEN
  ) {
    return initNetwork(NET_INPUTS, NET_HIDDEN, NET_OUTPUTS);
  }
  return {
    inputSize: NET_INPUTS,
    hiddenSize: NET_HIDDEN,
    outputSize: NET_OUTPUTS,
    W1: saved.W1,
    b1: saved.b1 ?? Array(NET_HIDDEN).fill(0),
    W2: saved.W2,
    b2: saved.b2 ?? Array(NET_OUTPUTS).fill(0),
  };
}

function createApe() {
  const saved = loadSave();
  const apeStart = randomLandCell();
  const net = hydrateNet(saved?.net);

  return {
    x: apeStart.x,
    y: apeStart.y,
    hunger: 100,
    foods: saved?.foods ?? 0,
    deaths: saved?.deaths ?? 0,
    age: saved?.age ?? 0,
    epsilon: saved?.epsilon ?? 0.3,
    net,
    lastFeatures: null,
    lastAction: null,
  };
}

function resetWorld() {
  createLandMask();
  drawTerrain();
  trees = new Set();
  rocks = new Set();
  placeFeatures(TREE_COUNT, trees);
  placeFeatures(ROCK_COUNT, rocks);
  seedFood();
  spawnPredators();
  ape = createApe();
  adviceRules = [];
  adviceId = 1;
  tick = 0;
  addChatLine("Ape", "New island generated. I will keep learning.");
}

function getNearest(list) {
  if (!list.length) {
    return null;
  }
  let nearest = list[0];
  let nearestDist = dist(ape, nearest);
  for (let i = 1; i < list.length; i += 1) {
    const d = dist(ape, list[i]);
    if (d < nearestDist) {
      nearest = list[i];
      nearestDist = d;
    }
  }
  return { target: nearest, distance: nearestDist };
}

function getNearestSet(set) {
  let nearest = null;
  let best = Number.POSITIVE_INFINITY;
  for (const item of set) {
    const [x, y] = item.split(",").map(Number);
    const d = Math.abs(ape.x - x) + Math.abs(ape.y - y);
    if (d < best) {
      best = d;
      nearest = { x, y };
    }
  }
  if (!nearest) {
    return null;
  }
  return { target: nearest, distance: best };
}

function buildStateFeatures() {
  const predatorInfo = getNearest(predators);
  const foodInfo = getNearest(food);
  const predatorDist = predatorInfo ? predatorInfo.distance : 10;
  const foodDist = foodInfo ? foodInfo.distance : 10;
  const predatorNear = predatorInfo ? (predatorInfo.distance <= 3 ? 1 : 0) : 0;
  const foodNear = foodInfo ? (foodInfo.distance <= 4 ? 1 : 0) : 0;

  return [
    ape.hunger / 100,
    clamp(predatorDist / 10, 0, 1),
    clamp(foodDist / 10, 0, 1),
    predatorNear,
    foodNear,
  ];
}

function stateIndex() {
  const predatorNear = getNearest(predators)?.distance <= 3;
  const hungry = ape.hunger <= 40;
  const foodNear = getNearest(food)?.distance <= 4;
  let idx = 0;
  if (predatorNear) idx += 1;
  if (hungry) idx += 2;
  if (foodNear) idx += 4;
  return idx;
}

function chooseAction(features) {
  const qValues = predictQ(ape.net, features);
  const valid = ACTIONS.map((action) => {
    const nx = ape.x + action.dx;
    const ny = ape.y + action.dy;
    if (action.name === "stay") {
      return true;
    }
    return !isBlocked(nx, ny);
  });

  let scores = qValues.slice();
  const adviceBias = buildAdviceBias();
  if (adviceBias) {
    scores = scores.map((score, idx) => score + adviceBias[idx]);
  }

  if (Math.random() < ape.epsilon) {
    const options = ACTIONS.map((action, idx) => ({ action, idx })).filter((item) => valid[item.idx]);
    return options[randInt(options.length)].idx;
  }

  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < scores.length; i += 1) {
    if (!valid[i]) {
      continue;
    }
    if (scores[i] > bestScore) {
      bestScore = scores[i];
      bestIdx = i;
    }
  }
  return bestIdx;
}

function buildAdviceBias() {
  if (!adviceRules.length) {
    return null;
  }
  const activeRules = adviceRules.filter((rule) => evaluateCondition(rule.condition));
  if (!activeRules.length) {
    return null;
  }
  const bias = Array(ACTIONS.length).fill(0);
  const weight = 0.6 / activeRules.length;
  activeRules.forEach((rule) => {
    const partial = actionBias(rule.action, weight);
    if (!partial) {
      return;
    }
    for (let i = 0; i < bias.length; i += 1) {
      bias[i] += partial[i];
    }
  });
  return bias;
}

function actionBias(action, weight) {
  const bias = Array(ACTIONS.length).fill(0);
  if (!action) {
    return null;
  }
  if (action.type === "avoidPredator") {
    const nearest = getNearest(predators);
    if (!nearest) {
      return null;
    }
    ACTIONS.forEach((move, idx) => {
      const nx = ape.x + move.dx;
      const ny = ape.y + move.dy;
      const d = Math.abs(nx - nearest.target.x) + Math.abs(ny - nearest.target.y);
      bias[idx] = (d - nearest.distance) * weight * 0.5;
    });
  } else if (action.type === "seekFood") {
    const nearest = getNearest(food);
    if (!nearest) {
      return null;
    }
    ACTIONS.forEach((move, idx) => {
      const nx = ape.x + move.dx;
      const ny = ape.y + move.dy;
      const d = Math.abs(nx - nearest.target.x) + Math.abs(ny - nearest.target.y);
      bias[idx] = (nearest.distance - d) * weight * 0.5;
    });
  } else if (action.type === "direction") {
    ACTIONS.forEach((move, idx) => {
      if (move.name === action.dir) {
        bias[idx] = weight * 1.2;
      } else if (move.name !== "stay") {
        bias[idx] = -weight * 0.4;
      }
    });
  } else if (action.type === "seekTrees") {
    const nearest = getNearestSet(trees);
    if (!nearest) {
      return null;
    }
    ACTIONS.forEach((move, idx) => {
      const nx = ape.x + move.dx;
      const ny = ape.y + move.dy;
      const d = Math.abs(nx - nearest.target.x) + Math.abs(ny - nearest.target.y);
      bias[idx] = (nearest.distance - d) * weight * 0.35;
    });
  } else if (action.type === "avoidRocks") {
    const nearest = getNearestSet(rocks);
    if (!nearest) {
      return null;
    }
    ACTIONS.forEach((move, idx) => {
      const nx = ape.x + move.dx;
      const ny = ape.y + move.dy;
      const d = Math.abs(nx - nearest.target.x) + Math.abs(ny - nearest.target.y);
      bias[idx] = (d - nearest.distance) * weight * 0.4;
    });
  } else if (action.type === "stay") {
    bias[0] = weight * 1.2;
  }

  return bias;
}

function evaluateCondition(condition) {
  if (!condition || condition.type === "always") {
    return true;
  }
  if (condition.type === "hunger") {
    if (condition.op === ">") {
      return ape.hunger > condition.value;
    }
    return ape.hunger < condition.value;
  }
  if (condition.type === "predatorNear") {
    return getNearest(predators)?.distance <= 3;
  }
  if (condition.type === "foodNear") {
    return getNearest(food)?.distance <= 4;
  }
  return true;
}

function updatePredators() {
  predators.forEach((predator) => {
    const targetDistance = dist(predator, ape);
    let dir = predator.dir;

    if (targetDistance <= 8 && Math.random() < 0.8) {
      const options = ACTIONS.filter((action) => action.name !== "stay");
      options.sort((a, b) => {
        const da = Math.abs(predator.x + a.dx - ape.x) + Math.abs(predator.y + a.dy - ape.y);
        const db = Math.abs(predator.x + b.dx - ape.x) + Math.abs(predator.y + b.dy - ape.y);
        return da - db;
      });
      dir = options[0];
    } else if (Math.random() < 0.3) {
      dir = ACTIONS[randInt(ACTIONS.length)];
    }

    const nx = predator.x + dir.dx;
    const ny = predator.y + dir.dy;
    if (!isBlocked(nx, ny)) {
      predator.x = nx;
      predator.y = ny;
      predator.dir = dir;
    }
  });
}

function applyAction(actionIdx) {
  const action = ACTIONS[actionIdx];
  const nx = ape.x + action.dx;
  const ny = ape.y + action.dy;
  if (!isBlocked(nx, ny)) {
    ape.x = nx;
    ape.y = ny;
  }
}

function eatFood() {
  let ate = false;
  food = food.filter((item) => {
    if (item.x === ape.x && item.y === ape.y) {
      ate = true;
      return false;
    }
    return true;
  });
  if (ate) {
    ape.foods += 1;
    ape.hunger = clamp(ape.hunger + 45, 0, 100);
  }
  return ate;
}

function respawn(reason) {
  const spawn = randomLandCell();
  ape.x = spawn.x;
  ape.y = spawn.y;
  ape.hunger = 100;
  ape.deaths += 1;
  addChatLine("Ape", `I lost a life to ${reason}, but I will keep learning.`);
}

function update() {
  tick += 1;

  ape.hunger = clamp(ape.hunger - 0.8, 0, 100);
  ape.age += 1;

  const features = buildStateFeatures();
  const actionIdx = chooseAction(features);
  applyAction(actionIdx);

  const ate = eatFood();

  updatePredators();

  let reward = -0.02;
  if (ate) {
    reward += 1.2;
  }

  let died = false;
  const predatorHit = predators.some((predator) => predator.x === ape.x && predator.y === ape.y);
  if (predatorHit) {
    reward -= 2;
    died = true;
    respawn("a predator");
  } else if (ape.hunger <= 0) {
    reward -= 1.5;
    died = true;
    respawn("starvation");
  }

  const nextFeatures = buildStateFeatures();
  const future = died ? 0 : Math.max(...predictQ(ape.net, nextFeatures));
  const target = reward + NET_GAMMA * future;
  trainNetwork(ape.net, features, actionIdx, target);

  ape.lastFeatures = features;
  ape.lastAction = actionIdx;

  if (!died && tick % 6 === 0) {
    if (food.length < MAX_FOOD && Math.random() < 0.45) {
      spawnFood();
    }
  }

  ape.epsilon = Math.max(0.05, ape.epsilon * 0.999);

  if (tick % 30 === 0) {
    saveState();
  }

  drawHud();
}

function render() {
  ctx.drawImage(terrainCanvas, 0, 0);

  for (const item of trees) {
    const [x, y] = item.split(",").map(Number);
    ctx.fillStyle = COLORS.tree;
    ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
  }

  for (const item of rocks) {
    const [x, y] = item.split(",").map(Number);
    ctx.fillStyle = COLORS.rock;
    ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
  }

  food.forEach((item) => {
    ctx.fillStyle = COLORS.food;
    ctx.fillRect(item.x * CELL, item.y * CELL, CELL, CELL);
  });

  predators.forEach((predator) => {
    ctx.fillStyle = COLORS.predator;
    ctx.fillRect(predator.x * CELL, predator.y * CELL, CELL, CELL);
  });

  ctx.fillStyle = COLORS.ape;
  ctx.fillRect(ape.x * CELL, ape.y * CELL, CELL, CELL);
}

function drawHud() {
  statsEl.innerHTML = "";
  const stats = [
    { label: "Lives", value: "infinite" },
    { label: "Deaths", value: ape.deaths },
    { label: "Foods", value: ape.foods },
    { label: "Hunger", value: `${Math.round(ape.hunger)}%` },
    { label: "Epsilon", value: ape.epsilon.toFixed(2) },
  ];

  stats.forEach((stat) => {
    const div = document.createElement("div");
    div.className = "stat";
    div.innerHTML = `<strong>${stat.label}</strong>${stat.value}`;
    statsEl.appendChild(div);
  });

  const predatorDist = getNearest(predators)?.distance ?? "?";
  const foodDist = getNearest(food)?.distance ?? "?";
  const activeRules = getActiveAdviceRules();
  const allAdviceText = adviceRules.length ? adviceRules.map((rule) => rule.text).join(" | ") : "none";
  const activeAdviceText = activeRules.length ? activeRules.map((rule) => rule.text).join(" | ") : "none";

  readoutEl.innerHTML = `
    <div><strong>Brain:</strong> Neural net policy</div>
    <div><strong>AI State:</strong> ${stateLabel()}</div>
    <div><strong>Nearest Predator:</strong> ${predatorDist} tiles</div>
    <div><strong>Nearest Food:</strong> ${foodDist} tiles</div>
    <div><strong>Advice Rules:</strong> ${allAdviceText}</div>
    <div><strong>Active Now:</strong> ${activeAdviceText}</div>
  `;
}

function stateLabel() {
  const predatorNear = getNearest(predators)?.distance <= 3;
  const hungry = ape.hunger <= 40;
  const foodNear = getNearest(food)?.distance <= 4;
  const tags = [];
  if (predatorNear) tags.push("predator near");
  if (hungry) tags.push("hungry");
  if (foodNear) tags.push("food near");
  return tags.length ? tags.join(", ") : "calm";
}

function addChatLine(speaker, message) {
  const line = document.createElement("div");
  line.className = "chat-line";
  line.innerHTML = `<span>${speaker}:</span> ${message}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function splitAdviceText(text) {
  const match = text.match(/\b(when|if)\b/);
  if (!match || match.index === undefined) {
    return { actionText: text.trim(), conditionText: "" };
  }
  const idx = match.index;
  const actionText = text.slice(0, idx).trim();
  const conditionText = text.slice(idx).replace(/^(when|if)\s*/, "").trim();
  return { actionText, conditionText };
}

function parseCondition(text) {
  const source = text.trim();
  if (!source) {
    return { type: "always" };
  }
  if (source.includes("always")) {
    return { type: "always" };
  }
  const hungerMatch = source.match(
    /hunger[^0-9]*(<=|>=|<|>|below|under|less than|over|above|greater than)?\s*(\d{1,3})\s*%?/
  );
  if (hungerMatch) {
    const rawOp = hungerMatch[1] ?? "below";
    const value = clamp(Number(hungerMatch[2]), 0, 100);
    const op = rawOp === ">" || rawOp === ">=" || rawOp === "over" || rawOp === "above" || rawOp === "greater than" ? ">" : "<";
    return { type: "hunger", op, value };
  }
  if (source.includes("hungry")) {
    return { type: "hunger", op: "<", value: 40 };
  }
  if (source.includes("predator") && (source.includes("near") || source.includes("close"))) {
    return { type: "predatorNear" };
  }
  if (source.includes("food") && (source.includes("near") || source.includes("close"))) {
    return { type: "foodNear" };
  }
  return { type: "always" };
}

function parseAction(text) {
  if (!text) {
    return null;
  }
  const hasPredator = text.includes("predator");
  const hasAvoid =
    text.includes("avoid")
    || text.includes("stay away")
    || text.includes("keep away")
    || text.includes("dont")
    || text.includes("don't")
    || text.includes("do not");
  const hasFlee = text.includes("flee") || text.includes("run") || text.includes("escape") || text.includes("hide");
  if (hasPredator && (hasAvoid || hasFlee)) {
    return { type: "avoidPredator" };
  }
  const hasRock = text.includes("rock") || text.includes("rocks") || text.includes("stone") || text.includes("boulder");
  const hasNo =
    text.includes("avoid")
    || text.includes("stay away")
    || text.includes("keep away")
    || text.includes("dont")
    || text.includes("don't")
    || text.includes("do not");
  if (hasRock && hasNo) {
    return { type: "avoidRocks" };
  }
  if (text.includes("food") || text.includes("eat") || text.includes("forage") || text.includes("berries") || text.includes("fruit")) {
    return { type: "seekFood" };
  }
  if (text.includes("tree") || text.includes("forest")) {
    return { type: "seekTrees" };
  }
  if (
    text.includes("stay")
    || text.includes("wait")
    || text.includes("hold")
    || text.includes("freeze")
    || text.includes("still")
    || text.includes("dont move")
    || text.includes("don't move")
  ) {
    return { type: "stay" };
  }
  if (text.includes("north") || text.includes("up")) {
    return { type: "direction", dir: "up" };
  }
  if (text.includes("south") || text.includes("down")) {
    return { type: "direction", dir: "down" };
  }
  if (text.includes("west") || text.includes("left")) {
    return { type: "direction", dir: "left" };
  }
  if (text.includes("east") || text.includes("right")) {
    return { type: "direction", dir: "right" };
  }
  return null;
}

function interpretAction(text) {
  const ruleAction = parseAction(text);
  if (ruleAction) {
    return ruleAction;
  }
  const ml = classifyAdviceAction(text);
  if (ml.action && ml.confidence >= 0.6) {
    return ml.action;
  }
  return null;
}

function describeAction(action) {
  if (!action) {
    return "do nothing";
  }
  if (action.type === "avoidPredator") return "avoid predators";
  if (action.type === "avoidRocks") return "avoid rocks";
  if (action.type === "seekFood") return "seek food";
  if (action.type === "seekTrees") return "stay near trees";
  if (action.type === "stay") return "stay put";
  if (action.type === "direction") {
    if (action.dir === "up") return "go north";
    if (action.dir === "down") return "go south";
    if (action.dir === "left") return "go west";
    if (action.dir === "right") return "go east";
  }
  return "do nothing";
}

function describeCondition(condition) {
  if (!condition || condition.type === "always") {
    return "";
  }
  if (condition.type === "hunger") {
    const op = condition.op === ">" ? ">" : "<";
    return `hunger ${op} ${condition.value}%`;
  }
  if (condition.type === "predatorNear") {
    return "predators nearby";
  }
  if (condition.type === "foodNear") {
    return "food nearby";
  }
  return "";
}

function formatRuleText(action, condition) {
  const actionText = describeAction(action);
  const conditionText = describeCondition(condition);
  if (!conditionText) {
    return actionText;
  }
  return `${actionText} when ${conditionText}`;
}

function getActiveAdviceRules() {
  return adviceRules.filter((rule) => evaluateCondition(rule.condition));
}

function parseAdvice(message) {
  const lower = message.toLowerCase();
  if (
    lower.includes("clear")
    || lower.includes("forget")
    || lower.trim() === "stop"
    || lower.trim() === "stop it"
    || lower.trim() === "stop now"
    || lower.includes("stop advice")
    || lower.includes("stop listening")
    || lower.includes("cancel")
    || lower.includes("never mind")
    || lower.includes("nevermind")
  ) {
    return { kind: "clear" };
  }

  const { actionText, conditionText } = splitAdviceText(lower);
  const action = interpretAction(actionText || lower);
  if (!action) {
    return { kind: "unknown" };
  }
  let condition = parseCondition(conditionText);
  if (condition.type === "always" && !conditionText) {
    const fallback = parseCondition(lower);
    if (fallback.type !== "always") {
      condition = fallback;
    }
  }
  const text = formatRuleText(action, condition);
  return {
    kind: "add",
    rule: {
      id: adviceId++,
      action,
      condition,
      text,
    },
  };
}

function saveState() {
  const payload = {
    version: 2,
    net: ape.net,
    foods: ape.foods,
    deaths: ape.deaths,
    age: ape.age,
    epsilon: ape.epsilon,
  };
  try {
    localStorage.setItem("apeSave", JSON.stringify(payload));
  } catch (error) {
    console.warn("Save failed", error);
  }
}

function loadSave() {
  try {
    const raw = localStorage.getItem("apeSave");
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (parsed.version !== 2) {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function loop() {
  const stepMs = 1000 / LOGIC_RATE;
  let last = performance.now();
  let acc = 0;

  function frame(now) {
    acc += now - last;
    last = now;
    while (acc >= stepMs) {
      update();
      acc -= stepMs;
    }
    render();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) {
    return;
  }
  addChatLine("You", text);
  const result = parseAdvice(text);
  if (result.kind === "clear") {
    adviceRules = [];
    addChatLine("Ape", "Advice cleared. I will keep learning.");
  } else if (result.kind === "add") {
    adviceRules.push(result.rule);
    addChatLine("Ape", `Rule saved: ${result.rule.text}. I will keep it even if I lose a life.`);
  } else {
    addChatLine("Ape", "I did not understand. Try: \"get food when hunger is below 50%\".");
  }
  chatInput.value = "";
});

resetButton.addEventListener("click", () => {
  saveState();
  resetWorld();
});

adviceModel = buildAdviceModel();
resetWorld();
loop();
