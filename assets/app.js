const qs = (s) => document.querySelector(s);

const messagesEl = qs('#messages');
const form = qs('#chatForm');
const input = qs('#chatInput');
const sendBtn = qs('#sendBtn');
const chipsEl = qs('#chips');

const QUICK_PROMPTS = [
  "What is the Business Location overall score for Rwanda, and how does it compare to Kenya?",
  "For Nigeria, what does the dataset say about land registry digital services?",
  "Which economies have the highest scores in Market Competition overall?",
  "In Business Entry, what is the reported minimum capital requirement for a standard LLC in India?",
  "For Brazil, summarize the key constraints reported in International Trade."
];

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  div.innerHTML = `
    <div class="role">${role === 'user' ? 'You' : 'Bot'}</div>
    <div class="content"></div>
  `;
  div.querySelector('.content').textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function setMessageText(msgDiv, text) {
  msgDiv.querySelector('.content').textContent = text;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendMessage(text) {
  const userDiv = addMessage('user', text);
  const botDiv = addMessage('bot', 'Thinking…');
  sendBtn.disabled = true;
  input.disabled = true;

  try {
    const res = await fetch('/.netlify/functions/chatfinal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: getHistoryForApi()
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || 'Request failed');
    }
    setMessageText(botDiv, data.answer || '(No answer)');
  } catch (e) {
    setMessageText(botDiv, `Error: ${e.message}`);
  } finally {
    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

function getHistoryForApi() {
  // Keep a short local history: last ~8 messages
  const nodes = Array.from(messagesEl.querySelectorAll('.msg'));
  const items = nodes.slice(-8).map(n => ({
    role: n.classList.contains('user') ? 'user' : 'assistant',
    content: n.querySelector('.content').textContent
  }));
  return items;
}

function initChips() {
  for (const p of QUICK_PROMPTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = p;
    b.addEventListener('click', () => {
      input.value = p;
      input.focus();
    });
    chipsEl.appendChild(b);
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendMessage(text);
});

initChips();
addMessage('bot', "Hi! Ask me anything about the Business Ready 2025 dataset (all topics + economies). I’ll cite the underlying rows I used.");
