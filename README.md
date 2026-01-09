# Business Ready 2025 – Netlify Chatbot (dataset-grounded)

This is a ready-to-deploy Netlify app that answers questions using the **Business Ready 2025** dataset you provided.

## How it works

- The dataset is stored locally in `/data` as **gzipped JSONL**:
  - `econ_answers.jsonl.gz` – ~189k survey question/answer rows
  - `topic_scores.jsonl.gz` – topic/pillar score tables
- A Netlify Function (`/.netlify/functions/chat`) does:
  1) keyword retrieval over the gzipped JSONL (streams line-by-line)
  2) passes the **top matching rows as context** to the OpenAI API (Responses API)
  3) returns a grounded answer with citations like `(E3)` or `(S2)` referring to context rows.

If `OPENAI_API_KEY` is not set, the app falls back to returning the most relevant rows it found.

## Deploy on Netlify

### Option A — Git-based (recommended)
1. Create a new Git repo and add all files in this folder.
2. In Netlify: **Add new site → Import from Git**
3. Build settings:
   - Build command: *(none)*
   - Publish directory: `.`
4. Environment variables (Netlify → Site settings → Environment variables):
   - `OPENAI_API_KEY` = your key (**required for full chat**)
   - Optional: `OPENAI_MODEL` (default: `gpt-5.2`)

### Option B — Drag & drop (no git)
Netlify’s UI supports drag & drop for static sites, but **Functions typically require a git deploy**.
If you want drag & drop, use the Netlify CLI:
1. `npm i -g netlify-cli`
2. `netlify login`
3. From this folder: `netlify deploy --prod`

## Example questions

- “Business Location overall score for Rwanda”
- “For Kenya, what does the dataset say about environmental permitting timelines?”
- “Compare Business Entry overall between Vietnam and Indonesia”
- “In Dispute Resolution, what is the economy response for *[variable name]* in Peru?”

## Notes / limits

- Retrieval is keyword-based (fast, simple). If you want semantic search later, you can add embeddings or a vector DB, but this version is intentionally easy to deploy.
- The assistant is instructed to answer only from retrieved context. If your question is too broad, you’ll get a “need more specificity” response.
