cat > netlify/functions/chat2.js <<'EOF'
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type"
    },
    body: JSON.stringify(obj)
  };
}

function openGzLineReader(filePath) {
  const stream = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  return { rl, stream };
}

function isNumeric(v) {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "string") return false;
  return /^-?\d+(\.\d+)?$/.test(v.trim());
}
function toNumber(v) {
  return typeof v === "number" ? v : parseFloat(String(v).trim());
}
function norm(s) {
  return String(s || "").trim().toLowerCase();
}
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Cache economies & topics from the scores file (cold start cost once) */
let CACHE = {
  loaded: false,
  economies: [],   // original case (as in file)
  economiesNorm: [], // normalized
  topics: []       // normalized topics observed
};

async function loadCache(scorePath) {
  if (CACHE.loaded) return CACHE;

  const econSet = new Map(); // norm -> original (prefer first seen)
  const topicSet = new Set();

  const { rl } = openGzLineReader(scorePath);

  await new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      if (!line) return;
      let row;
      try { row = JSON.parse(line); } catch { return; }

      const econ = row.Economy || row.economy;
      if (econ) {
        const eN = norm(econ);
        if (!econSet.has(eN)) econSet.set(eN, String(econ).trim());
      }

      const t = row.topic;
      if (t) topicSet.add(norm(t));
    });

    rl.on("close", resolve);
    rl.on("error", reject);
  });

  CACHE.economiesNorm = Array.from(econSet.keys()).sort((a,b)=>b.length-a.length);
  CACHE.economies = CACHE.economiesNorm.map(k => econSet.get(k));
  CACHE.topics = Array.from(topicSet);

  CACHE.loaded = true;
  return CACHE;
}

/** Find up to 2 economies mentioned in question by scanning known economy names */
function detectEconomies(question, cache) {
  const q = norm(question);
  const found = [];

  for (let i = 0; i < cache.economiesNorm.length; i++) {
    const eN = cache.economiesNorm[i];
    // whole-phrase match (allow punctuation boundaries)
    const re = new RegExp(`(^|[^a-z])${escapeRegExp(eN)}([^a-z]|$)`, "i");
    if (re.test(q)) {
      found.push({ norm: eN, original: cache.economies[i] });

