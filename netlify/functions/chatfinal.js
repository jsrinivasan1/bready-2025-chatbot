const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

// Vocabulary Map: Helps the bot understand "jobs" means "Labor"
const SYNONYMS = {
  "jobs": "labor", "employment": "labor", "work": "labor",
  "electricity": "utility services", "power": "utility services",
  "starting": "business entry", "incorporation": "business entry",
  "property": "business location", "taxes": "taxation"
};

const STOP = new Set([
  "the","and","for","with","what","does","say","about","from","into","that","this","are","was","were","how","when",
  "which","give","show","list","tell","summarize","summary","compare","between","across","all","any","data","dataset",
  "topic","topics","economy","economies","please"
]);

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

// Fuzzy Logic: Calculates similarity between words to handle typos
function getSimilarity(s1, s2) {
  let longer = s1.length < s2.length ? s2 : s1;
  let shorter = s1.length < s2.length ? s1 : s2;
  if (longer.length === 0) return 1.0;
  const editDistance = (function(a, b) {
    let matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) matrix[i][j] = matrix[i - 1][j - 1];
        else matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
    return matrix[b.length][a.length];
  })(longer, shorter);
  return (longer.length - editDistance) / parseFloat(longer.length);
}

function tokenize(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(" ")
    .map((t) => {
      const term = t.trim();
      return SYNONYMS[term] || term;
    })
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

function scoreText(hay, tokens) {
  if (!hay) return 0;
  const t = String(hay).toLowerCase();
  let s = 0;
  for (const tok of tokens) {
    if (t.includes(tok)) s += 1;
  }
  return s;
}

function openGzLineReader(filePath) {
  const stream = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  return { rl, stream };
}

function detectTopic(question) {
  const q = String(question || "").toLowerCase();
  if (q.includes("business location") || q.includes("property transfer")) return "Business Location";
  if (q.includes("business entry")) return "Business Entry";
  if (q.includes("labor") || q.includes("employment")) return "Labor";
  if (q.includes("utility") || q.includes("electric") || q.includes("water")) return "Utility Services";
  if (q.includes("tax")) return "Taxation";
  return null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function searchGzJsonl(filePath, query, opts) {
  opts = opts || {};
  const tokens = tokenize(query);
  const isRankingQuery = /top|best|highest|rank|leader|highest\s+score/i.test(query);
  const maxRows = opts.maxRows || 30;
  const best = [];
  const { rl } = openGzLineReader(filePath);

  return await new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      if (!line) return;
      let row;
      try { row = JSON.parse(line); } catch { return; }

      if (opts.economy) {
        const re = (row.economy || row.Economy || "").toString().toLowerCase();
        if (re && re !== String(opts.economy).toLowerCase()) return;
      }

      const hay = [row.economy, row.Economy, row.topic, row.var, row.question, row.response].filter(Boolean).join(" | ");
      const keywordScore = scoreText(hay, tokens);
      const numericValue = parseFloat(row["Business Location Overall"] || row["Business Entry Overall"] || row["Overall Score"] || 0);
      const finalSortScore = isRankingQuery ? numericValue : keywordScore;

      best.push({ score: finalSortScore, row });
      best.sort((a, b) => b.score - a.score);
      if (best.length > maxRows) best.pop();
    });
    rl.on("close", () => resolve(best));
    rl.on("error", reject);
  });
}

function buildContext(econMatches, scoreMatches) {
  let out = "";
  if (scoreMatches && scoreMatches.length) {
    out += "SCORES (Numeric Data):\n";
    scoreMatches.forEach((m, i) => {
      const r = m.row || {};
      const dataPoints = Object.entries(r)
        .filter(([k, v]) => k.toLowerCase().includes("score") || k.toLowerCase().includes("overall") || typeof v === "number")
        .map(([k, v]) => `${k}: ${v}`).join(", ");
      out += `S${i + 1}. Economy=${r.Economy || r.economy || ""}; Topic=${r.topic || ""}; ${dataPoints}\n`;
    });
    out += "\n";
  }
  if (econMatches && econMatches.length) {
    out += "ECONOMY ANSWERS (Specific Details):\n";
    econMatches.forEach((m, i) => {
      const r = m.row || {};
      const resp = String(r.response || "").slice(0, 400);
      out += `E${i + 1}. Economy=${r.economy || r.Economy || ""}; Topic=${r.topic || ""}; Q=${r.question || ""}; A=${resp}\n`;
    });
  }
  return out.trim();
}

async function callOpenAI(question, history, context) {
  const messages = [
    {
      role: "system",
      content: "You are a Senior Economic Analyst for Business Ready 2025. Analyze data comparing performance against benchmarks. Always use Markdown tables. Use corrected names if typos found. Cite sources (S1, E2, etc.)."
    },
    ...(history || []).slice(-8),
    { role: "user", content: `QUESTION:\n${question}\n\nCONTEXT:\n${context}` }
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: OPENAI_MODEL, messages })
  });

  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "(No output)";
}

async function loadEconSetOnce(scorePath) {
  if (globalThis.__ECON_SET__) return globalThis.__ECON_SET__;
  const set = new Set();
  const { rl } = openGzLineReader(scorePath);
  return await new Promise((resolve) => {
    rl.on("line", (line) => {
      try { 
        const row = JSON.parse(line); 
        const econ = (row.Economy || row.economy || "").toString().trim().toLowerCase();
        if (econ) set.add(econ);
      } catch {}
    });
    rl.on("close", () => { globalThis.__ECON_SET__ = set; resolve(set); });
  });
}

function pickEconomyFromQuestion(q, econSet) {
  const text = q.toLowerCase();
  let bestMatch = "";
  for (const econ of econSet) {
    if (text.includes(econ) && econ.length > bestMatch.length) bestMatch = econ;
  }
  if (bestMatch) return bestMatch;
  const words = text.split(/\s+/);
  for (const word of words) {
    if (word.length < 4) continue;
    for (const econ of econSet) {
      if (getSimilarity(word, econ) > 0.85) return econ;
    }
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  try {
    const payload = JSON.parse(event.body || "{}");
    const message = String(payload.message || "").trim();
    const history = payload.history || [];
    
    const econPath = path.join(__dirname, "data", "econ_answers.jsonl.gz");
    const scorePath = path.join(__dirname, "data", "topic_scores.jsonl.gz");
    
    const econSet = await loadEconSetOnce(scorePath);
    const detectedEconomy = pickEconomyFromQuestion(message, econSet);
    const detectedTopic = detectTopic(message);

    const msgForScoring = detectedEconomy ? message.replace(new RegExp(escapeRegExp(detectedEconomy), "ig"), " ") : message;

    const globalMatches = !detectedEconomy ? await searchGzJsonl(scorePath, "overall score", { maxRows: 10 }) : [];
    const scoreMatches = await searchGzJsonl(scorePath, msgForScoring, { maxRows: 50, economy: detectedEconomy });
    const econMatches = await searchGzJsonl(econPath, msgForScoring, { maxRows: 40, economy: detectedEconomy, topic: detectedTopic });

    let context = buildContext(econMatches, scoreMatches);
    if (globalMatches.length > 0) {
      context = "GLOBAL TOP PERFORMERS:\n" + buildContext([], globalMatches) + "\n\n" + context;
    }

    const answer = await callOpenAI(message, history, context);
    return json(200, { answer });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
