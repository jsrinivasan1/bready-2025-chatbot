const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

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
  const isRankingQuery = /top|best|highest|rank|leader|highest\s+score/i.test(query);
  const maxRows = opts.maxRows || 30;
  const minScore = isRankingQuery ? 0 : (opts.minScore || 1); // Allow all rows if we are ranking

  const best = [];
  const { rl } = openGzLineReader(filePath);

  return await new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      if (!line) return;
      let row;
      try { row = JSON.parse(line); } catch { return; }

      // Filters
      if (opts.topic) {
        const rt = (row.topic || "").toString().toLowerCase();
        if (rt && rt !== String(opts.topic).toLowerCase()) return;
      }
      if (opts.economy) {
        const re = (row.economy || row.Economy || "").toString().toLowerCase();
        if (re && re !== String(opts.economy).toLowerCase()) return;
      }

      // 1. Calculate Keyword Relevance
      const hay = [
        row.economy, row.Economy, row.topic, row.var, row.question, row.response
      ].filter(Boolean).join(" | ");
      const keywordScore = scoreText(hay, tokens);

      // 2. Extract Numeric Score for Sorting
      // Looks for keys like "Overall Score" or "Business Location Overall"
      const numericValue = parseFloat(
        row["Business Location Overall"] || 
        row["Business Entry Overall"] || 
        row["Overall Score"] || 0
      );

      // 3. Decide Rank: If user asks for "top", prioritize the numericValue. 
      // Otherwise, prioritize the keyword match.
      const finalSortScore = isRankingQuery ? numericValue : keywordScore;

      if (!isRankingQuery && finalSortScore < minScore) return;

      best.push({ score: finalSortScore, row });
      
      // Keep the highest scores at the top
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
      
      // This part looks for any field that contains "Score", "Overall", or "Points"
      // so the AI can actually see the numeric results.
      const dataPoints = Object.entries(r)
        .filter(([k, v]) => 
          k.toLowerCase().includes("score") || 
          k.toLowerCase().includes("overall") || 
          k.toLowerCase().includes("index") ||
          typeof v === "number"
        )
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");

      out += `S${i + 1}. Economy=${r.Economy || r.economy || ""}; Topic=${r.topic || ""}; ${dataPoints}\n`;
    });
    out += "\n";
  }

  if (econMatches && econMatches.length) {
    out += "ECONOMY ANSWERS (Specific Details):\n";
    econMatches.forEach((m, i) => {
      const r = m.row || {};
      const resp = (r.response == null) ? "" : String(r.response);
      const snippet = resp.slice(0, 400);
      const tail = resp.length > 400 ? "..." : "";
      out += `E${i + 1}. Economy=${r.economy || r.Economy || ""}; Topic=${r.topic || ""}; Q=${r.question || ""}; A=${snippet}${tail}\n`;
    });
  }

  return out.trim();
}
// --- Helper functions moved outside for cleaner syntax ---
async function callOpenAI(question, history, context) {
  const messages = [
    {
      role: "system",
      content:
        "You are a data-grounded assistant for the Business Ready 2025 dataset. " +
        "Answer ONLY using the provided CONTEXT. " +
        "When asked for scores across multiple topics or economies, ALWAYS use a Markdown Table. " +
        "Columns should include: Economy, Topic, and Score/Value. " +
        "If the context is insufficient, explain what is missing. " +
        "Always cite facts using row IDs like (E3) or (S2)."
    }
  ];

  if (Array.isArray(history)) {
    messages.push(...history.slice(-8));
  }

  messages.push({
    role: "user",
    content: `QUESTION:\n${question}\n\nCONTEXT:\n${context}`
  });

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ 
      model: OPENAI_MODEL, 
      messages: messages 
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI API error (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  
  // Modern OpenAI responses store the text in choices[0].message.content
  return data.choices?.[0]?.message?.content?.trim() || "(No text output)";
}
async function loadEconSetOnce(scorePath) {
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

function pickEconomyFromQuestion(q, econSet) {
  const text = q.toLowerCase();
  const tail = text.match(/\b(?:for|in|of)\s+([a-z][a-z\s\.\-']{2,})\s*\??\s*$/i);
  if (tail) {
    const cand = tail[1].trim().toLowerCase();
    if (econSet.has(cand)) return cand;
  }
  const vs = text.match(/([a-z][a-z\s\.\-']{2,})\s+(?:vs\.?|versus|and)\s+([a-z][a-z\s\.\-']{2,})/i);
  if (vs) {
    const a = vs[1].trim().toLowerCase();
    const b = vs[2].trim().toLowerCase();
    if (econSet.has(a)) return a;
    if (econSet.has(b)) return b;
  }
  let best = "";
  for (const econ of econSet) {
    if (econ.length < 4) continue;
    if (text.includes(econ) && econ.length > best.length) best = econ;
  }
  return best || null;
}

// --- Main Netlify Handler ---

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
    const econSet = await loadEconSetOnce(scorePath);
    const detectedEconomy = pickEconomyFromQuestion(message, econSet);

    // For scoring, remove the detected economy phrase (if any)
    const msgForScoring = detectedEconomy
      ? message.replace(new RegExp(escapeRegExp(detectedEconomy), "ig"), " ")
      : message;

    // For "overall score" queries
    const wantsOverall =
      /overall\s+score|overall\b|score\b|index\b/i.test(message) &&
      (detectedTopic === "Business Location" || /business\s+location|property\s+transfer/i.test(message));

    if (wantsOverall && detectedEconomy) {
      const scoreRow = await getTopicScoreRow(scorePath, detectedEconomy, detectedTopic);
      if (!scoreRow) {
        return json(200, {
          answer: `I couldn’t find a topic score row for Economy="${detectedEconomy}" and Topic="${detectedTopic}".`
        });
      }
      const overallKeys = Object.keys(scoreRow).filter(k => k.toLowerCase().includes("overall"));
      const overall = overallKeys.length ? scoreRow[overallKeys[0]] : null;

      return json(200, {
        answer: `**${detectedEconomy} — ${detectedTopic}**\n` +
          (overall !== null ? `Overall: ${overall}\n` : `I found the score row, but no field containing "overall".\n`)
      });
    }

    // ✅ NEW CODE
const scoreMatches = await searchGzJsonl(scorePath, msgForScoring, {
  maxRows: 50, // Grab more rows to see all topics
  minScore: 1,
  economy: detectedEconomy 
  // Notice 'topic: detectedTopic' is REMOVED so we get ALL topics for the country
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
    console.error(e);
    return json(500, { error: String(e && e.message ? e.message : e) });
  }
};
