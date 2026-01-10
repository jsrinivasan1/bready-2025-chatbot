// Netlify Function: /.netlify/functions/chat
// Reads gzipped JSONL datasets from /data, retrieves top matching rows, and (optionally) asks OpenAI to draft a grounded answer.
// Set OPENAI_API_KEY in Netlify environment variables.
// Optional: set OPENAI_MODEL (default gpt-5.2).

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(body));
}

function tokenize(q) {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

const STOP = new Set([
  "the","and","for","with","what","does","say","about","from","into","that","this","are","was","were","how","when",
  "which","give","show","list","tell","summarize","summary","compare","between","across","all","any","data","dataset",
  "topic","topics","economy","economies","please"
]);

function scoreText(hay, tokens) {
  if (!hay) return 0;
  const t = hay.toLowerCase();
  let s = 0;
  for (const tok of tokens) {
    if (t.includes(tok)) s += 1;
  }
  return s;
}

async function searchGzJsonl(filePath, query, opts = {}) {
  const tokens = tokenize(query);
  const maxRows = opts.maxRows || 30;
  const minScore = opts.minScore || 2;

  const stream = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  /** @type {{score:number, row:any}[]} */
  const best = [];

  for await (const line of rl) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }

    // Optional hard filters
    if (opts.topic && row.topic && String(row.topic).toLowerCase() !== String(opts.topic).toLowerCase()) continue;
    if (opts.economy && row.economy && String(row.economy).toLowerCase() !== String(opts.economy).toLowerCase()) continue;

    // Score against key fields
    const hay = [
      row.economy, row.topic, row.var, row.question, row.response,
      row["Economy Code"], row["Business Location Overall"], row["Business Entry Overall"]
    ].filter(Boolean).join(" | ");

    const s = scoreText(hay, tokens);
    if (s < minScore) continue;

    best.push({ score: s, row });
    best.sort((a,b) => b.score - a.score);
    if (best.length > maxRows) best.pop();
  }

  return best;
}

function buildContext(econMatches, scoreMatches) {
  let out = "";
  if (scoreMatches.length) {
    out += "SCORES (topic-level and pillar/category scores):\n";
    scoreMatches.forEach((m, i) => {
      const r = m.row;
      const economy = r.Economy || r.economy || "";
      const topic = r.topic || "";
      // keep context compact: include only key numeric fields plus any score-like fields containing "Overall"
      const entries = [];
      for (const [k,v] of Object.entries(r)) {
        if (k === "topic") continue;
        if (k === "Economy" || k === "Economy Code") continue;
        if (typeof v === "number" || (typeof v === "string" && v.match(/^\d+(\.\d+)?$/))) {
          if (k.toLowerCase().includes("overall") || k.toLowerCase().includes("pillar")) {
            entries.push(`${k}: ${v}`);
          }
        }
      }
      out += `S${i+1}. Economy=${economy}; Topic=${topic}; ${entries.slice(0, 18).join("; ")}\n`;
    });
    out += "\n";
  }

  if (econMatches.length) {
    out += "ECONOMY ANSWERS (survey questions + economy responses):\n";
    econMatches.forEach((m, i) => {
      const r = m.row;
      const snippet = (r.response || "").toString().slice(0, 400);
      out += `E${i+1}. Economy=${r.economy}; Topic=${r.topic}; Var=${r.var}; Q=${r.question}; A=${snippet}${(r.response||"").length>400?"...":""}\n`;
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
        "When you use a fact, cite the row IDs like (E3) or (S2). " +
        "Prefer precise values, named economies/topics, and avoid speculation."
    },
    ...(Array.isArray(history) ? history.slice(-8) : []),
    {
      role: "user",
      content: `QUESTION:\n${question}\n\nCONTEXT:\n${context}`
    }
  ];

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI API error (${resp.status}): ${errText}`);
  }
  const data = await resp.json();

  // Extract text output (Responses API can return multiple items)
  const parts = [];
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && item.content) {
        for (const c of item.content) {
          if (c.type === "output_text" && c.text) parts.push(c.text);
        }
      }
    }
  }
  const answer = parts.join("\n").trim() || "(No text output)";
  return answer;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch { payload = {}; }
  const message = (payload.message || "").toString().trim();
  const history = payload.history || [];

  if (!message) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing message" }) };
  }

  const econPath = path.join(__dirname, "..", "..", "data", "econ_answers.jsonl.gz");
  const scorePath = path.join(__dirname, "..", "..", "data", "topic_scores.jsonl.gz");

  try {
    const scoreMatches = await searchGzJsonl(scorePath, message, { maxRows: 10, minScore: 1 });
    const econMatches = await searchGzJsonl(econPath, message, { maxRows: 24, minScore: 2 });

    const context = buildContext(econMatches, scoreMatches);

 const econPath = path.join(__dirname, "..", "..", "data", "econ_answers.j>
  const scorePath = path.join(__dirname, "..", "..", "data", "topic_scores.>    // No key? Return a deterministic, grounded fallback.
    if (!OPENAI_API_KEY) {
      const fallback =
        "OPENAI_API_KEY is not set on the server, so I can'
t generate a natural-language answer yet.\n\n" +
        "Here are the most relevant dataset rows I found (use these to answer manually, or set the env var to enable full chat):\n\n" +
        context;
      return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ answer: fallback }) };
    }

    const answer = await callOpenAI(message, history, context);
    return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ answer }) };
  } catch (e) {
    return { statusCode: 500, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ error: e.message }) };
  }
};
