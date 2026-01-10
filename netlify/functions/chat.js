NU nano 8.7             netlify/functions/chat.js              Modified
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch { payload = {}; }
  const message = (payload.message || "").toString().trim();
  const history = payload.history || [];

  if (!message) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing messag>
  }

  const econPath = path.join(__dirname, "..", "..", "data", "econ_answers.j>
  const scorePath = path.join(__dirname, "..", "..", "data", "topic_scores.>

  try {
    const scoreMatches = await searchGzJsonl(scorePath, message, { maxRows:>
    const econMatches = await searchGzJsonl(econPath, message, { maxRows: 2>

    const context = buildContext(econMatches, scoreMatches);

 const econPath = path.join(__dirname, "..", "..", "data", "econ_answers.j>
  const scorePath = path.join(__dirname, "..", "..", "data", "topic_scores.>
    if (!OPENAI_API_KEY) {
      const fallback =
        "OPENAI_API_KEY is not set on the server, so I can'
t generate a natural-language answer yet.\n\n" +
        "Here are the most relevant dataset rows I found (use these to answ>
        context;
      return { statusCode: 200, headers: { "Content-Type": "application/jso>
    }

    const answer = await callOpenAI(message, history, context);
    return { statusCode: 200, headers: { "Content-Type": "application/json;>
  } catch (e) {
    return { statusCode: 500, headers: { "Content-Type": "application/json;>
  }
};
