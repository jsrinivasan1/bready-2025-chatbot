const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

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

const STOP = new Set([
  "the","and","for","with","what","does","say","about","from","into","that","this","are","was","were","how","when",
  "which","give","show","list","tell","summarize","summary","compare","between","across","all","any","data","dataset",
  "topic","topics","economy","economies","please"
]);

function tokenize(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(" ")
    .map((t) => t.trim())
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

function detectEconomySimple(question) {
  const q = String(question || "").trim();

  let m = q.match(/^(?:for\s+)?([A-Za-z][A-Za-z\s\.\-']{2,})[:,]/i);
  if (m) return m[1].trim();

  m = q.match(/\b(?:in|of|for)\s+([A-Za-z][A-Za-z\s\.\-']{2,})\b/i);
  if (m) return m[1].trim();

  return null;
}

function detectTopic(question) {
  const q = String(question || "").toLowerCase();

  if (
    q.includes("business location") ||
    q.includes("property transfer") ||
    q.includes("land registry") ||
    q.includes("land registration") ||
    q.includes("title registry") ||
    q.includes("cadastre") ||
    q.includes("registry")
  ) {
    return "Business Location";
  }

  if (q.includes("business entry")) return "Business Entry";
  if (q.includes("labor") || q.includes("employment")) return "Labor";
  if (q.includes("utility") || q.includes("electric") || q.includes("water")) return "Utility Services";
  if (q.includes("tax")) return "Taxation";

  return null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getTopicScoreRow(scorePath, economyName, topicName) {
  const { rl } = openGzLineReader(scorePath);

  const econNeedle = String(economyName || "").toLowerCase();
  const topicNeedle = String(topicName || "").toLowerCase();

  return await new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      if (!line) return;
      let row;
      try { row = JSON.parse(line); } catch { return; }

      const econ = (row.Economy || row.economy || "").toString().toLowerCase();
      const topic = (row.topic || "").toString().toLowerCase();

      if (econ === econNeedle && (!topicNeedle || topic === topicNeedle)) {
        resolve(row);
        rl.close();
      }
    });
    rl.on("close", () => resolve(null));
    rl.on("error", reject);
  });
}

async function searchGzJsonl(filePath, query, opts) {
  opts = opts || {};
  const tokens = tokenize(query);
  const maxRows = opts.maxRows || 30;
  const minScore = opts.minScore || 1;

  const best = [];
  const { rl } = openGzLineReader(filePath);

  return await new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      if (!line) return;

      let row;
      try { row = JSON.parse(line); } catch { return; }

      // Hard filters
      if (opts.topic) {
        const rt = (row.topic || "").toString().toLowerCase();
        if (rt && rt !== String(opts.topic).toLowerCase()) return;
      }
      if (opts.economy) {
        const re = (row.economy || row.Economy || "").toString().toLowerCase();
        if (re && re !== String(opts.economy).toLowerCase()) return;
      }

      const hay = [
        row.economy, row.Economy, row.topic, row.var, row.question, row.response,
        row["Economy Code"], row["Business Location Overall"], row["Business Entry Overall"]
      ].filter(Boolean).join(" | ");

      const s = scoreText(hay, tokens);
      if (s < minScore) return;

      best.push({ score: s, row });
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
    out += "SCORES:\n";
    scoreMatches.forEach((m, i) => {
      const r = m.row || {};
      out += `S${i + 1}. Economy=${r.Economy || r.economy || ""}; Topic=${r.topic || ""}\n`;
    });
    out += "\n";
  }

  if (econMatches && econMatches.length) {
    out += "ECONOMY ANSWERS:\n";
    econMatches.forEach((m, i) => {
      const r = m.row || {};
      const resp = (r.response == null) ? "" : String(r.response);
      const snippet = resp.slice(0, 400);
      const tail = resp.length > 400 ? "..." : "";
      out += `E${i + 1}. Economy=${r.economy || r.Economy || ""}; Topic=${r.topic || ""}; Var=${r.var || ""}; Q=${r.question || ""}; A=${snippet}${tail}\n`;
    });
  }

  return out.trim();
}

async function callOpenAI(question, history, context) {
  const input = [
    {
      role: "system",
      content:
        "You are a data-grounded assistant for the Business Ready 2025 dataset. " +
        "Answer ONLY using the provided CONTEXT. " +
        "If the context is insufficient, say what is missing and suggest a more specific question. " +
        "When you use a fact, cite row IDs like (E3) or (S2)."
    }
  ];

  if (Array.isArray(history)) input.push(...history.slice(-8));

  input.push({
    role: "user",
    content: `QUESTION:\n${question}\n\nCONTEXT:\n${context}`
  });

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: OPENAI_MODEL, input })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI API error (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const parts = [];
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === "output_text" && c.text) parts.push(c.text);
        }
      }
    }
  }
  return parts.join("\n").trim() || "(No text output)";
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" },
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); } catch { payload = {}; }

  const message = String(payload.message || "").trim();
  const history = payload.history || [];

  if (!message) return json(400, { error: "Missing message" });

  const econPath = path.join(__dirname, "data", "econ_answers.jsonl.gz");
  const scorePath = path.join(__dirname, "data", "topic_scores.jsonl.gz");

  try {
    const detectedTopic = detectTopic(message);
// Build a real economy set from the scores file (cached per warm function)
globalThis.__ECON_SET__ = globalThis.__ECON_SET__ || null;

async function loadEconSetOnce() {

  if (globalThis.__ECON_SET__) return globalThis.__ECON_SET__;

  const set = new Set();
  const { rl } = openGzLineReader(scorePath);

  await new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      if (!line) return;
      let row;
      try { row = JSON.parse(line); } catch { return; }
      const econ = (row.Economy || row.economy || "").toString().trim().toLowerCase();
      if (econ) set.add(econ);
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });

  globalThis.__ECON_SET__ = set;
  return set;
}

  // Also handle "X vs Y" / "X and Y" patterns (return first; compare can be added later)
  const vs = text.match(/([a-z][a-z\s\.\-']{2,})\s+(?:vs\.?|versus|and)\s+([a-z][a-z\s\.\-']{2,})/i);
  if (vs) {
    const a = vs[1].trim().toLowerCase();
    const b = vs[2].trim().toLowerCase();
    if (econSet.has(a)) return a;
    if (econSet.has(b)) return b;
  }

  // Finally: longest economy phrase contained anywhere in the question
  let best = "";
  for (const econ of econSet) {
    if (econ.length < 4) continue;
    if (text.includes(econ) && econ.length > best.length) best = econ;
  }
  return best || null;
}


// For scoring, remove the detected economy phrase (if any)
const msgForScoring = detectedEconomy
  ? message.replace(new RegExp(escapeRegExp(detectedEconomy), "ig"), " ")
  : message;

    // For "overall score" queries, do direct lookup in topic scores
    const wantsOverall =
      /overall\s+score|overall\b|score\b|index\b/i.test(message) &&
      (detectedTopic === "Business Location" || /business\s+location|property\s+transfer/i.test(message));

    if (wantsOverall && detectedEconomy) {
      const scoreRow = await getTopicScoreRow(scorePath, detectedEconomy, detectedTopic);
      if (!scoreRow) {
        return json(200, {
          answer:
            `I couldn’t find a topic score row for Economy="${detectedEconomy}" and Topic="${detectedTopic}". ` +
            `Try using the exact economy name as in the dataset.`
        });
      }
      const overallKeys = Object.keys(scoreRow).filter(k => k.toLowerCase().includes("overall"));
      const overall = overallKeys.length ? scoreRow[overallKeys[0]] : null;

      return json(200, {
        answer:
          `**${detectedEconomy} — ${detectedTopic}**\n` +
          (overall !== null ? `Overall: ${overall}\n` : `I found the score row, but no field containing "overall".\n`) +
          `Fields with "overall": ${overallKeys.join(", ") || "(none)"}`
      });
    }

// Build a real economy set from the scores file (cached per warm function)
globalThis.__ECON_SET__ = globalThis.__ECON_SET__ || null;


function pickEconomyFromQuestion(q, econSet) {
  const text = q.toLowerCase();

  // Prefer "for X" / "in X" / "of X" at the END of the question
  const tail = text.match(/\b(?:for|in|of)\s+([a-z][a-z\s\.\-']{2,})\s*\??\s*$/i);
  if (tail) {
    const cand = tail[1].trim().toLowerCase();
    if (econSet.has(cand)) return cand;
  }

  // Also handle "X vs Y" / "X and Y" patterns (return first; compare can be added later)
  const vs = text.match(/([a-z][a-z\s\.\-']{2,})\s+(?:vs\.?|versus|and)\s+([a-z][a-z\s\.\-']{2,})/i);
  if (vs) {
    const a = vs[1].trim().toLowerCase();
    const b = vs[2].trim().toLowerCase();
    if (econSet.has(a)) return a;
    if (econSet.has(b)) return b;
  }

  // Finally: longest economy phrase contained anywhere in the question
  let best = "";
  for (const econ of econSet) {
    if (econ.length < 4) continue;
    if (text.includes(econ) && econ.length > best.length) best = econ;
  }
  return best || null;
}

const econSet = await loadEconSetOnce();
const detectedEconomy = pickEconomyFromQuestion(message, econSet);

// For scoring, remove the detected economy phrase (if any)

    const scoreMatches = await searchGzJsonl(scorePath, msgForScoring, {
      maxRows: 10,
      minScore: 1,
      economy: detectedEconomy,
      topic: detectedTopic
    });

    const econMatches = await searchGzJsonl(econPath, msgForScoring, {
      maxRows: 40,
      minScore: 1,
      economy: detectedEconomy,
      topic: detectedTopic
    });

    const context = buildContext(econMatches, scoreMatches);

    if (!OPENAI_API_KEY) {
      return json(200, { answer: "OPENAI_API_KEY not set.\n\n" + context });
    }

    const answer = await callOpenAI(message, history, context);
    return json(200, { answer });
  } catch (e) {
    return json(500, { error: String(e && e.message ? e.message : e) });
  }
};
