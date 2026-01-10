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
  for (let i = 0; i < tokens.length; i++) {
    if (t.indexOf(tokens[i]) !== -1) s += 1;
  }
  return s;
}

function openGzLineReader(filePath) {
  const stream = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  return { rl, stream };
}

async function searchGzJsonl(filePath, query, opts) {
  opts = opts || {};
  const tokens = tokenize(query);
  const maxRows = opts.maxRows || 30;
  const minScore = opts.minScore || 2;

  const best = [];

  const { rl } = openGzLineReader(filePath);

  return await new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      if (!line) return;

      let row;
      try {
        row = JSON.parse(line);
      } catch (e) {
        return;
      }

      if (opts.topic && row.topic && String(row.topic).toLowerCase() !== String(opts.topic).toLowerCase()) return;
      if (opts.economy && row.economy && String(row.economy).toLowerCase() !== String(opts.economy).toLowerCase()) return;

      const hay = [
        row.economy, row.topic, row.var, row.question, row.response,
        row["Economy Code"], row["Business Location Overall"], row["Business Entry Overall"]
      ].filter(Boolean).join(" | ");

      const s = scoreText(hay, tokens);
      if (s < minScore) return;

      best.push({ score: s, row: row });
      best.sort((a, b) => b.score - a.score);
      if (best.length > maxRows) best.pop();
    });

    rl.on("close", () => resolve(best));
    rl.on("error", (err) => reject(err));
  });
}

function buildContext(econMatches, scoreMatches) {
  let out = "";

  if (scoreMatches && scoreMatches.length) {
    out += "SCORES (topic-level and pillar/category scores):\n";
    for (let i = 0; i < scoreMatches.length; i++) {
      const r = scoreMatches[i].row || {};
      const economy = r.Economy || r.economy || "";
      const topic = r.topic || "";
      const entries = [];
      for (const k in r) {
        if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
        const v = r[k];
        if (k === "topic" || k === "Economy" || k === "Economy Code") continue;
        const isNum = (typeof v === "number") || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v));
        if (isNum) {
          const lk = String(k).toLowerCase();
          if (lk.indexOf("overall") !== -1 || lk.indexOf("pillar") !== -1) {
            entries.push(String(k) + ": " + String(v));
          }
        }
      }
      out += "S" + (i + 1) + ". Economy=" + economy + "; Topic=" + topic + "; " + entries.slice(0, 18).join("; ") + "\n";
    }
    out += "\n";
  }

  if (econMatches && econMatches.length) {
    out += "ECONOMY ANSWERS (survey questions + economy responses):\n";
    for (let i = 0; i < econMatches.length; i++) {
      const r = econMatches[i].row || {};
      const resp = (r.response == null) ? "" : String(r.response);
      const snippet = resp.slice(0, 400);
      const tail = resp.length > 400 ? "..." : "";
      out += "E" + (i + 1) + ". Economy=" + (r.economy || "") + "; Topic=" + (r.topic || "") +
        "; Var=" + (r.var || "") + "; Q=" + (r.question || "") + "; A=" + snippet + tail + "\n";
    }
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
    }
  ];

  if (Array.isArray(history)) {
    const h = history.slice(-8);
    for (let i = 0; i < h.length; i++) input.push(h[i]);
  }

  input.push({
    role: "user",
    content: "QUESTION:\n" + question + "\n\nCONTEXT:\n" + context
  });

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + OPENAI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: input
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error("OpenAI API error (" + resp.status + "): " + errText);
  }

  const data = await resp.json();

  const parts = [];
  if (Array.isArray(data.output)) {
    for (let i = 0; i < data.output.length; i++) {
      const item = data.output[i];
      if (item && item.type === "message" && Array.isArray(item.content)) {
        for (let j = 0; j < item.content.length; j++) {
          const c = item.content[j];
          if (c && c.type === "output_text" && c.text) parts.push(c.text);
        }
      }
    }
  }
  const answer = parts.join("\n").trim();
  return answer || "(No text output)";
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
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    payload = {};
  }

  const message = String(payload.message || "").trim();
  const history = payload.history || [];

  if (!message) {
    return json(400, { error: "Missing message" });
  }

  // Data files are copied into netlify/functions/data by build.sh
  const econPath = path.join(__dirname, "data", "econ_answers.jsonl.gz");
  const scorePath = path.join(__dirname, "data", "topic_scores.jsonl.gz");

  try {
    const scoreMatches = await searchGzJsonl(scorePath, message, { maxRows: 10, minScore: 1 });
    const econMatches = await searchGzJsonl(econPath, message, { maxRows: 24, minScore: 2 });

    const context = buildContext(econMatches, scoreMatches);

    if (!OPENAI_API_KEY) {
      return json(200, {
        answer:
          "OPENAI_API_KEY is not set on the server, so I cannot generate a natural-language answer yet.\n\n" +
          "Here are the most relevant dataset rows I found:\n\n" +
          context
      });
    }

    const answer = await callOpenAI(message, history, context);
    return json(200, { answer: answer });
  } catch (e) {
    return json(500, { error: String(e && e.message ? e.message : e) });
  }
};
// BUILD_BUMP Sat Jan 10 13:12:42 EST 2026
