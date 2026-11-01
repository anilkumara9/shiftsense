'use strict';
/* D Shift renderer — a faithful port of the original SwiftUI sidebar
   (ChatView.swift / AgentComponents.swift / HistoryAndFeedback.swift),
   with our additions kept in the same visual language. */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'gpt-5', 'gpt-5-mini', 'ollama:llama3.1'];
const TOOL_LABELS = { read_screen: ['Read screen', 'Read screen'], take_screenshot: ['Screenshot', 'Screenshot'], search_memory: ['Searched memory', 'Searching memory'], write_memory: ['Saved to memory', 'Saving to memory'], use_computer: ['Computer task', 'Computer task'] };
const SLASH = [
  { name: '/auto', summary: () => autoOn ? 'Turn off auto mode (ask before computer use)' : 'Auto mode: always allow computer use' },
  { name: '/new', summary: () => 'Start a new chat tab' },
  { name: '/clear', summary: () => 'Clear this chat' },
  { name: '/history', summary: () => 'Reopen a past chat' },
  { name: '/copy', summary: () => 'Copy the last reply' },
  { name: '/memory', summary: () => 'Open the memory folder' },
  { name: '/help', summary: () => 'List commands' },
];
let S = null, SETTINGS = null, busy = false, runningTab = null, autoOn = false;
let streamEl = null, streamTab = null, turnStartedAt = null, thinkTimer = null;
let toolLog = {};           // tabId -> [entries] live tool/task/info entries, in arrival order
let queueMap = {};          // tabId -> [{text}]
let queuePaused = {}, interruptNext = {};
let draftAtts = [];         // [{dataUrl, jpegBase64, app?, title?}]
let pinned = true, cmdHighlight = 0, memSel = null, fbShotB64 = null;
const ZOOM_LEVELS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];
let zoom = parseFloat(localStorage.getItem('textZoom') || '1');

const activeTab = () => S?.tabs.find(t => t.id === S.activeId) || S?.tabs[0];
const fmtCompact = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);
const fmtPct = f => (f > 0 && f < 0.001) ? '<0.1%' : (f * 100).toFixed(f < 0.1 ? 1 : 0) + '%';
const pixGrid = () => `<span class="pixgrid">${'<i></i>'.repeat(9)}</span>`;

/* ---------- transcript rendering ---------- */
function inlineMd(t) {
  return esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|\W)\*([^*]+)\*/g, '$1<i>$2</i>').replace(/\[([^\]]+)\]\((https:[^)]+)\)/g, '<a href="$2" data-ext>$1</a>');
}
function renderAssistantText(text, streaming) {
  const parts = String(text || '').split('```');
  return parts.map((p, i) => {
    if (i % 2 === 1) { const lines = p.split('\n'); if (lines[0] && !lines[0].includes(' ')) lines.shift(); return `<div class="codeblock">${esc(lines.join('\n').replace(/^\n+|\n+$/g, ''))}</div>`; }
    const prose = p.replace(/^\n+|\n+$/g, ''); if (!prose) return '';
    return inlineMd(prose) + (streaming && i === parts.length - 1 ? '<span class="cursor"> ▍</span>' : '');
  }).join('');
}
function toolSummary(input) { if (!input) return ''; for (const k of ['title', 'query', 'url', 'command', 'path', 'scope']) if (typeof input[k] === 'string') return input[k]; return ''; }
function chipHTML(e) {
  const [doneLabel, runLabel] = TOOL_LABELS[e.name] || [e.name, e.name];
  const st = e.status === 'done' ? '<span class="st ok">✓</span>' : e.status === 'error' ? '<span class="st bad">✕</span>' : `<span class="st">${pixGrid()}</span>`;
  const label = e.status === 'done' || e.status === 'error' ? doneLabel : runLabel;
  const sum = toolSummary(e.input);
  return `<div class="chipwrap" data-tid="${e.id}">
    <span class="chip" data-act="expand">${st}<span>${esc(e.status === 'done' || e.status === 'error' ? label : '')}${e.status !== 'done' && e.status !== 'error' ? `<span class="shimmer">${esc(label)}</span>` : ''}</span>${sum ? `<span class="sum">${esc(sum)}</span>` : ''}</span>
    ${e.image ? `<img class="chipimg${e.expanded ? ' big' : ''}" src="data:image/jpeg;base64,${e.image}">` : ''}
    ${e.expanded ? `<div class="tooldetail"><div class="dl">Input</div><pre>${esc(JSON.stringify(e.input || {}, null, 1)).slice(0, 2000)}</pre><div class="dl">Output</div><pre>${esc(e.output || '').slice(0, 2000)}</pre></div>` : ''}
  </div>`;
}
function pillFor(status) {
  return { running: ['Running', 'blue'], waiting: ['Waiting', 'orange'], done: ['Completed', 'green'], error: ['Failed', 'red'], denied: ['Denied', 'gray'], cancelled: ['Cancelled', 'gray'] }[status] || ['Running', 'blue'];
}
function taskHTML(e) {
  if (e.status === 'waiting') {
    return `<div class="approval fadeup" data-tid="${e.id}">
      <div class="at"><span>Let Codex do this?</span><button class="iconbtn" data-act="deny">✕</button></div>
      <div class="ad">${esc(e.task || '')}</div>
      <button class="choice" data-act="allow"><span class="gi">●</span> Allow</button>
      <button class="choice" data-act="deny"><span>○</span> Deny</button>
    </div>`;
  }
  const [lbl, cls] = pillFor(e.status);
  const badge = e.status === 'done' ? '<span class="badge" style="background:#30d158">✓</span>' : e.status === 'error' ? '<span class="badge" style="background:#ff453a">✕</span>' : e.status === 'denied' ? '<span class="badge" style="background:#8e8e93">⊘</span>' : pixGrid();
  const steps = (e.steps || []).slice(-12);
  return `<div class="taskcard" data-tid="${e.id}">
    <div class="taskhead" data-act="expand">${badge}<span class="tt">${esc(e.task || 'Computer task')}</span>
    <span class="elapsed">${e.elapsed || ''}</span><span class="pill ${cls}">${lbl}</span>
    ${e.status === 'running' ? '<button class="stopbtn" data-act="stoptask" title="Stop this computer task">■</button>' : ''}<span class="tertiary">${e.expanded ? '▴' : '▾'}</span></div>
    ${e.expanded ? `<div class="tasksteps">${steps.length ? steps.map(s => `<div>${esc(s)}</div>`).join('') : `<div>${esc(e.task || '')}</div>`}</div>` : ''}
  </div>`;
}
function renderTranscript() {
  const t = activeTab(); const tr = $('#transcript'); if (!t) { tr.innerHTML = ''; return; }
  let html = '';
  if (!t.display?.length && !(toolLog[t.id] || []).length) {
    html += `<div class="empty"><div>Ask about what's on your screen.</div><div class="sub">Tap Ctrl+Shift anywhere to attach the window you're on. /clear resets the chat.</div></div>`;
  }
  for (const m of t.display || []) {
    if (m.role === 'user') {
      html += `<div class="msg-user fadeup">${(m.attachments || []).length ? `<div class="atts">${m.attachments.map(a => `<img src="${a}">`).join('')}</div>` : ''}${m.text ? `<div class="bubble">${esc(m.text)}</div>` : ''}</div>`;
    } else if (m.role === 'assistant') {
      html += `<div class="msg-asst fadeup"><div class="card">${renderAssistantText(m.text, false)}</div>${m.text ? `<div class="actions"><button class="iconbtn" data-act="copy" data-text="${esc(m.text)}" title="Copy">⧉</button></div>` : ''}</div>`;
    }
  }
  // live tool entries with his grouping: consecutive chips collapse, tasks stand alone
  const entries = toolLog[t.id] || [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    if (group.length === 1) html += chipHTML(group[0]);
    else {
      const active = [...group].reverse().find(g => g.status === 'running' || g.status === 'waiting');
      html += `<div class="toolgroup" data-tid="${group[0].id}" data-group="1"><button class="ghead" data-act="group">🔧 ${group.length} tool calls <span class="tertiary">${group.some(g => g.expanded) ? '▴' : '▾'}</span></button>${group.some(g => g.expanded) ? `<div class="gchildren">${group.map(chipHTML).join('')}</div>` : active ? chipHTML(active) : ''}</div>`;
    }
    group = [];
  };
  for (const e of entries) {
    if (e.kind === 'task') { flush(); html += taskHTML(e); }
    else if (e.kind === 'info') { flush(); html += `<div class="msg-asst fadeup"><div class="card">${esc(e.text)}</div></div>`; }
    else group.push(e);
  }
  flush();
  if (busy && runningTab === t.id) {
    const anyTool = entries.some(e => e.status === 'running');
    if (!streamEl && !anyTool) html += `<div class="thinking" id="thinkRow">${pixGrid()}<span class="shimmer">Thinking</span><span class="elapsed" id="thinkElapsed">0.0s</span></div>`;
    if (streamEl) html += `<div class="msg-asst"><div class="card" id="streamCard"></div></div>`;
  }
  tr.innerHTML = html;
  if (streamEl) { const c = $('#streamCard'); if (c) { c.innerHTML = renderAssistantText(streamEl, true); } }
  if (pinned) tr.scrollTop = tr.scrollHeight;
}
function renderUsage() {
  const t = activeTab(); const bar = $('#usagebar'); if (!t) { bar.innerHTML = ''; return; }
  const u = t.usage;
  bar.innerHTML = `<span title="${(u.lastRequestTotal || 0).toLocaleString()} of 1,000,000 tokens in the last request"><span class="meter${u.contextFraction > 0.8 ? ' hot' : ''}"><i style="width:${Math.max(7, 100 * Math.min(1, u.contextFraction))}%"></i></span> ${fmtPct(u.contextFraction)} context</span>
  <span>${fmtCompact(u.input + u.cacheRead + u.cacheWrite)} in</span><span>${fmtCompact(u.output)} out</span>
  ${u.requests > 0 ? `<span title="Cache reads ${u.cacheRead.toLocaleString()}, writes ${u.cacheWrite.toLocaleString()}">${fmtPct(u.cacheHitRate)} cached</span>` : ''}
  <span class="cost" title="Estimated at list prices over ${u.requests} requests · screen reads ${u.screenReads || 0} · screenshots ${u.screenshots || 0}${SETTINGS?.budgetUSDPerDay ? ` · budget $${SETTINGS.budgetUSDPerDay}/day, spent $${SETTINGS.spentToday ?? 0}` : ''}">$${u.costUSD < 1 ? u.costUSD.toFixed(3) : u.costUSD.toFixed(2)}</span>`;
}
function renderTabs() {
  const el = $('#tabs'); el.innerHTML = '';
  for (const t of S.tabs) {
    const d = document.createElement('div'); d.className = 'tab' + (t.id === S.activeId ? ' sel' : '');
    d.innerHTML = `${busy && runningTab === t.id ? '<span class="spin"></span>' : ''}<span class="tt">${esc(t.title)}</span>`;
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; x.title = 'Close chat';
    x.onclick = async ev => { ev.stopPropagation(); await refresh(await window.dshift.closeTab(t.id)); };
    d.appendChild(x);
    d.onclick = async () => { streamEl = null; await refresh(await window.dshift.activateTab(t.id)); };
    el.appendChild(d);
  }
  const plus = document.createElement('button'); plus.className = 'iconbtn'; plus.id = 'btnNew'; plus.textContent = '+'; plus.title = 'New chat (Ctrl+T)';
  plus.onclick = async () => refresh(await window.dshift.newTab());
  el.appendChild(plus);
  const sel = $('#modelSel'); sel.innerHTML = '';
  const t = activeTab();
  for (const m of MODELS) { const o = document.createElement('option'); o.value = m; o.textContent = m; if (t && m === t.model) o.selected = true; sel.appendChild(o); }
}
function renderQueue() {
  const t = activeTab(); const qv = $('#queueView'); if (!t) return;
  const q = queueMap[t.id] || [];
  if (!q.length) { qv.classList.add('hidden'); qv.innerHTML = ''; return; }
  qv.classList.remove('hidden');
  qv.innerHTML = `<div class="qh"><span>${queuePaused[t.id] ? 'Queued, paused' : 'Queued'}</span>${queuePaused[t.id] ? '<button data-q="resume">Resume</button>' : ''}</div>` +
    q.map((item, i) => `<div class="qrow"><span class="qt">${esc(item.text)}</span><button class="iconbtn" data-q="now" data-i="${i}" title="Send now (interrupts the current reply)">↑</button><button class="iconbtn" data-q="rm" data-i="${i}" title="Remove from queue">✕</button></div>`).join('');
}
function renderSendControls() {
  const sc = $('#sendControls'); const has = $('#input').value.trim().length > 0 || draftAtts.length > 0;
  if (busy) {
    sc.innerHTML = `${has ? '<button class="pillbtn" id="scQueue">Queue</button><button class="pillbtn" id="scNow">⚡ Send now</button>' : ''}<button class="roundbtn stop" id="scStop" title="Stop">■</button>`;
    const q = $('#scQueue'), n = $('#scNow');
    if (q) q.onclick = () => submit(false);
    if (n) n.onclick = () => submit(true);
    $('#scStop').onclick = () => window.dshift.stop();
  } else {
    sc.innerHTML = `<button class="roundbtn${has ? ' accent' : ''}" id="scSend" title="Send (Return)" ${has ? '' : 'disabled'}>↑</button>`;
    $('#scSend').onclick = () => submit(false);
  }
  $('#input').placeholder = busy ? 'Queue a message, or Ctrl+Return to send now' : 'Ask about your screen...';
}
function renderAtts() {
  const row = $('#attachRow');
  if (!draftAtts.length) { row.classList.add('hidden'); row.innerHTML = ''; return; }
  row.classList.remove('hidden');
  row.innerHTML = draftAtts.map((a, i) => a.app
    ? `<span class="attchip src"><img src="${a.dataUrl}"><span><div class="an">${esc(a.app)}</div><div class="at2">${esc(a.title || '')}</div></span><button class="rm" data-rm="${i}">✕</button></span>`
    : `<span class="attchip"><img src="${a.dataUrl}"><button class="rm" data-rm="${i}">✕</button></span>`).join('');
  row.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { draftAtts.splice(+b.dataset.rm, 1); renderAtts(); renderSendControls(); });
}
function renderAll() { renderTabs(); renderTranscript(); renderUsage(); renderQueue(); renderSendControls(); renderAtts(); applySetupGate(); }
async function refresh(patch) { const s = patch ? { state: patch, settings: SETTINGS } : await window.dshift.getState(); S = s.state; if (s.settings) SETTINGS = s.settings; renderAll(); }
function applySetupGate() {
  if (!SETTINGS) return;
  const need = (SETTINGS.provider === 'anthropic' && !SETTINGS.hasAnthropicKey) || (SETTINGS.provider === 'openai' && !SETTINGS.hasOpenAIKey);
  $('#setupView').classList.toggle('hidden', !need);
  $('#chatView').classList.toggle('hidden', need);
  if (need) { $('#setupView h2').textContent = SETTINGS.provider === 'openai' ? 'Add your OpenAI API key' : 'Add your Anthropic API key'; $('#setupKey').placeholder = SETTINGS.provider === 'openai' ? 'sk-...' : 'sk-ant-...'; }
}

/* ---------- send flow (his semantics: Return queues while running, Ctrl+Return interrupts) ---------- */
async function submit(sendNow) {
  const ta = $('#input'); const text = ta.value.trim();
  const t = activeTab(); if (!t || (!text && !draftAtts.length)) return;
  if (text.startsWith('/') && !text.includes(' ')) { const handled = await runSlash(text, t); if (handled) { ta.value = ''; hideCmdMenu(); return; } }
  ta.value = ''; hideCmdMenu();
  const atts = draftAtts; draftAtts = []; renderAtts();
  if (busy) {
    if (sendNow) { interruptNext[t.id] = { text, atts }; window.dshift.stop(); }
    else { (queueMap[t.id] = queueMap[t.id] || []).push({ text, atts }); }
    renderQueue(); renderSendControls(); return;
  }
  await runSend(t.id, text, atts);
  await drainQueue();
  renderAll();
}
async function drainQueue() {
  for (;;) { // interrupt first, then queue, unless paused
    const cur = activeTab(); if (!cur || busy) break;
    if (interruptNext[cur.id]) { const it = interruptNext[cur.id]; delete interruptNext[cur.id]; await runSend(cur.id, it.text, it.atts); continue; }
    if (queuePaused[cur.id]) break;
    const q = queueMap[cur.id] || []; if (!q.length) break;
    const it = q.shift(); renderQueue(); await runSend(cur.id, it.text, it.atts);
  }
  renderAll();
}
async function runSend(tabId, text, atts) {
  busy = true; runningTab = tabId; streamEl = null; turnStartedAt = Date.now();
  pinned = true; renderSendControls(); renderTabs(); renderTranscript();
  startThinkTimer();
  try { await window.dshift.send(tabId, text, atts); }
  finally { busy = false; runningTab = null; streamEl = null; stopThinkTimer(); }
  const s = await window.dshift.getState(); S = s.state; SETTINGS = s.settings;
}
function startThinkTimer() { stopThinkTimer(); thinkTimer = setInterval(() => { const el = $('#thinkElapsed'); if (el && turnStartedAt) el.textContent = ((Date.now() - turnStartedAt) / 1000).toFixed(1) + 's'; }, 100); }
function stopThinkTimer() { if (thinkTimer) clearInterval(thinkTimer); thinkTimer = null; }

/* ---------- slash commands (his exact list) ---------- */
async function runSlash(text, t) {
  const cmd = SLASH.find(c => c.name === text.toLowerCase()); if (!cmd) return false;
  if (cmd.name === '/new') await refresh(await window.dshift.newTab());
  else if (cmd.name === '/clear') await refresh(await window.dshift.clearChat(t.id));
  else if (cmd.name === '/memory') await window.dshift.openMemory();
  else if (cmd.name === '/history') openHistory();
  else if (cmd.name === '/copy') { const last = [...(t.display || [])].reverse().find(m => m.role === 'assistant'); if (last) await navigator.clipboard.writeText(last.text); }
  else if (cmd.name === '/auto') await toggleAuto();
  else if (cmd.name === '/help') { (toolLog[t.id] = toolLog[t.id] || []).push({ kind: 'info', id: 'help' + Date.now(), text: SLASH.map(c => `${c.name} — ${c.summary()}`).join('\n') }); renderTranscript(); }
  return true;
}
async function toggleAuto() { autoOn = !autoOn; await window.dshift.setAuto(autoOn); $('#autoHint').classList.toggle('on', autoOn); $('#autoText').textContent = autoOn ? 'auto mode on' : 'asks before computer use'; $('#autoIcon').textContent = autoOn ? '⏩' : '✋'; $('#inputCard').classList.toggle('auto', autoOn); }
$('#autoHint').onclick = toggleAuto;

/* ---------- command menu ---------- */
function slashMatches() { const v = $('#input').value; if (!v.startsWith('/') || v.includes(' ') || v.includes('\n')) return []; const typed = v.slice(1).toLowerCase(); return SLASH.filter(c => c.name.slice(1).startsWith(typed)); }
function renderCmdMenu() {
  const m = slashMatches(); const menu = $('#commandMenu');
  if (!m.length) { menu.classList.add('hidden'); return; }
  cmdHighlight = Math.min(cmdHighlight, m.length - 1);
  menu.classList.remove('hidden');
  menu.innerHTML = m.map((c, i) => `<button class="cmd${i === cmdHighlight ? ' hl' : ''}" data-cmd="${c.name}"><span class="cn">${c.name}</span><span class="cs">${esc(c.summary())}</span></button>`).join('');
  menu.querySelectorAll('[data-cmd]').forEach(b => b.onclick = () => { $('#input').value = b.dataset.cmd; submit(false); });
}
function hideCmdMenu() { $('#commandMenu').classList.add('hidden'); }

/* ---------- live events ---------- */
window.dshift.on('sidebar:shown', () => { $('#input').focus(); });
window.dshift.on('ctx:update', c => { $('#ctxApp').textContent = c.app || 'No app'; $('#ctxTitle').textContent = c.title || ''; });
window.dshift.on('chat:delta', ({ tabId, delta }) => {
  if (tabId !== S?.activeId || runningTab !== tabId) return;
  if (!streamEl) { streamEl = ''; renderTranscript(); }
  streamEl += delta;
  const card = $('#streamCard'); if (card) { card.innerHTML = renderAssistantText(streamEl, true); if (pinned) $('#transcript').scrollTop = $('#transcript').scrollHeight; }
});
window.dshift.on('chat:tool', ev => {
  const list = (toolLog[ev.tabId] = toolLog[ev.tabId] || []);
  if (ev.name === 'use_computer') return; // task entries come from the approval flow
  let e = list.find(x => x.id === ev.id);
  if (!e) { e = { kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running', output: '', expanded: false }; list.push(e); }
  if (ev.status === 'done') { e.status = 'done'; e.output = ev.output || ''; if (ev.image) e.image = ev.image; }
  if (ev.status === 'error') { e.status = 'error'; e.output = ev.output || ''; }
  if (ev.tabId === S?.activeId) renderTranscript();
});
window.dshift.on('codex:approval', req => {
  const tabId = runningTab || S?.activeId; if (!tabId) return;
  const list = (toolLog[tabId] = toolLog[tabId] || []);
  list.push({ kind: 'task', id: req.approvalId, task: req.task, status: 'waiting', steps: [], expanded: false });
  if (tabId === S.activeId) { pinned = true; renderTranscript(); }
});
window.dshift.on('codex:progress', p => {
  for (const id of Object.keys(toolLog)) { const e = toolLog[id].find(x => x.id === p.approvalId); if (e) { e.status = 'running'; (e.steps = e.steps || []).push(p.text); if (id === S?.activeId) renderTranscript(); } }
});
window.dshift.on('chat:error', ({ tabId, error }) => {
  const list = (toolLog[tabId] = toolLog[tabId] || []);
  list.push({ kind: 'info', id: 'err' + Date.now(), text: '⚠ ' + error });
  if ((queueMap[tabId] || []).length) queuePaused[tabId] = true; // his queue pauses on failure
  busy = false; runningTab = null; streamEl = null; stopThinkTimer();
  if (tabId === S?.activeId) { renderTranscript(); renderQueue(); renderSendControls(); }
});
window.dshift.on('state:patch', s => { if (!busy) { S = s; renderAll(); } else { S = s; renderUsage(); renderTabs(); } });
window.dshift.on('ui:openSettings', openSettings);

/* transcript clicks (expand chips, approval choices, copy, task stop) */
$('#transcript').addEventListener('click', async e => {
  const ext = e.target.closest('[data-ext]'); if (ext) { e.preventDefault(); window.dshift.openExternal(ext.getAttribute('href')); return; }
  const copyBtn = e.target.closest('[data-act="copy"]');
  if (copyBtn) { await navigator.clipboard.writeText(copyBtn.dataset.text || ''); copyBtn.textContent = '✓'; copyBtn.classList.add('copied'); setTimeout(() => { copyBtn.textContent = '⧉'; copyBtn.classList.remove('copied'); }, 1200); return; }
  const wrap = e.target.closest('[data-tid]'); if (!wrap) return;
  const id = wrap.dataset.tid; const t = activeTab(); if (!t) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (wrap.dataset.group && act === 'group') { const list = toolLog[t.id] || []; const start = list.findIndex(x => x.id === id); if (start >= 0) { const target = !list[start].expanded; for (let i = start; i < list.length && list[i].kind === 'tool'; i++) list[i].expanded = target; } renderTranscript(); return; }
  const entry = (toolLog[t.id] || []).find(x => x.id === id); if (!entry) return;
  if (act === 'allow') { entry.status = 'running'; entry.startedAt = Date.now(); window.dshift.codexDecision(true); renderTranscript(); }
  else if (act === 'deny') { entry.status = 'denied'; window.dshift.codexDecision(false); renderTranscript(); }
  else if (act === 'stoptask') { window.dshift.stop(); entry.status = 'cancelled'; renderTranscript(); }
  else if (act === 'expand' || e.target.closest('.taskhead')) { entry.expanded = !entry.expanded; renderTranscript(); }
  else if (e.target.classList.contains('chipimg')) { e.target.classList.toggle('big'); }
});
$('#transcript').addEventListener('scroll', () => { const tr = $('#transcript'); pinned = tr.scrollHeight - tr.scrollTop - tr.clientHeight <= 40; });
$('#queueView').addEventListener('click', e => {
  const b = e.target.closest('[data-q]'); if (!b) return; const t = activeTab(); if (!t) return;
  if (b.dataset.q === 'resume') { queuePaused[t.id] = false; renderQueue(); if (!busy) drainQueue().catch(() => {}); }
  if (b.dataset.q === 'rm') { queueMap[t.id].splice(+b.dataset.i, 1); renderQueue(); }
  if (b.dataset.q === 'now') { const [item] = queueMap[t.id].splice(+b.dataset.i, 1); interruptNext[t.id] = item; window.dshift.stop(); renderQueue(); }
});

/* ---------- composer ---------- */
const ta = $('#input');
ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(110, ta.scrollHeight) + 'px'; cmdHighlight = 0; renderCmdMenu(); renderSendControls(); });
ta.addEventListener('keydown', e => {
  const m = slashMatches();
  if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); toggleAuto(); return; }
  if (e.key === 'Tab' && m.length) { e.preventDefault(); ta.value = m[Math.min(cmdHighlight, m.length - 1)].name; renderCmdMenu(); return; }
  if (e.key === 'ArrowDown' && m.length) { e.preventDefault(); cmdHighlight = (cmdHighlight + 1) % m.length; renderCmdMenu(); return; }
  if (e.key === 'ArrowUp' && m.length) { e.preventDefault(); cmdHighlight = (cmdHighlight - 1 + m.length) % m.length; renderCmdMenu(); return; }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(true); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (m.length && !SLASH.find(c => c.name === ta.value.toLowerCase())) { ta.value = m[Math.min(cmdHighlight, m.length - 1)].name; } submit(false); }
});
$('#inputCard').addEventListener('dragover', e => { e.preventDefault(); $('#inputCard').classList.add('droptarget'); });
$('#inputCard').addEventListener('dragleave', () => $('#inputCard').classList.remove('droptarget'));
$('#inputCard').addEventListener('drop', async e => { e.preventDefault(); $('#inputCard').classList.remove('droptarget'); for (const f of e.dataTransfer.files) if (f.type.startsWith('image/')) await addImageFile(f); });
document.addEventListener('paste', async e => { for (const it of e.clipboardData?.items || []) if (it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) await addImageFile(f); } });
async function addImageFile(file) {
  const url = URL.createObjectURL(file); const img = new Image();
  await new Promise(r => { img.onload = r; img.src = url; });
  const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const dataUrl = c.toDataURL('image/jpeg', 0.8); URL.revokeObjectURL(url);
  draftAtts.push({ dataUrl, jpegBase64: dataUrl.split(',')[1] }); renderAtts(); renderSendControls();
}
$('#btnPhoto').onclick = () => $('#filePicker').click();
$('#filePicker').addEventListener('change', async e => { for (const f of e.target.files) await addImageFile(f); e.target.value = ''; });
$('#btnAppshot').onclick = async () => { const s = await window.dshift.appshot(); if (s.dataUrl) { draftAtts.push({ dataUrl: s.dataUrl, jpegBase64: s.jpegBase64, app: s.app, title: s.title }); renderAtts(); renderSendControls(); } };
$('#modelSel').onchange = async e => { const t = activeTab(); if (t) { S = await window.dshift.setTabModel(t.id, e.target.value); renderAll(); } };
document.addEventListener('click', e => { if (!e.target.closest('button, select, input, textarea, a, .chip, .tab, .taskhead, .histrow, .popover')) ta.focus(); });
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 't') { e.preventDefault(); window.dshift.newTab().then(refresh); }
  if (mod && e.key.toLowerCase() === 'w') { e.preventDefault(); const t = activeTab(); if (t) window.dshift.closeTab(t.id).then(refresh); }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); openHistory(); }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(1); }
  if (mod && e.key === '-') { e.preventDefault(); setZoom(-1); }
  if (mod && e.key === '0') { e.preventDefault(); zoom = 1; applyZoom(); }
});
function setZoom(dir) { const i = ZOOM_LEVELS.findIndex(z => z >= zoom - 0.001); zoom = ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir))]; applyZoom(); }
function applyZoom() { $('#app').style.zoom = zoom; localStorage.setItem('textZoom', String(zoom)); }

/* ---------- tab strip buttons / popovers ---------- */
$('#btnHide').onclick = () => window.close();
$('#btnMemory').onclick = openMemory;
$('#btnSettings').onclick = openSettings;
$('#btnFeedback').onclick = openFeedback;
$('#btnHistory').onclick = openHistory;
function closePops() { for (const id of ['#historyPop', '#feedbackPop', '#settingsPop', '#memoryPop']) $(id).classList.add('hidden'); }
document.addEventListener('pointerdown', e => { if (!e.target.closest('.popover') && !e.target.closest('#btnHistory,#btnFeedback,#btnSettings,#btnMemory')) closePops(); });

async function openHistory() {
  closePops(); $('#historyPop').classList.remove('hidden'); $('#histSearch').value = ''; await renderHistory(''); $('#histSearch').focus();
}
async function renderHistory(q) {
  const [archived] = await Promise.all([window.dshift.historyList()]);
  const t = activeTab();
  const rows = [...(S?.tabs || []).map(x => ({ id: x.id, title: x.title, preview: (x.display?.find(m => m.role === 'user')?.text || '').slice(0, 90), open: true, updatedAt: null })),
    ...archived.map(a => ({ ...a, open: false }))].filter(r => !q || r.title.toLowerCase().includes(q) || (r.preview || '').toLowerCase().includes(q));
  $('#histList').innerHTML = rows.length ? rows.map(r => `<div class="histrow" data-hid="${r.id}" data-open="${r.open}"><div><div class="ht">${esc(r.title)}${r.open ? '<span class="dot"></span>' : ''}</div><div class="hp">${esc(r.preview || '')}</div><div class="hm">${r.updatedAt ? new Date(r.updatedAt).toLocaleString() : 'open now'}</div></div>${r.open ? '' : '<button class="iconbtn trash" data-del="${r.id}" title="Delete chat">🗑</button>'}</div>`).join('')
    : `<div class="secondary">${S?.tabs?.length || archived.length ? 'No matches.' : 'No saved chats yet.'}</div>`;
  $('#histList').querySelectorAll('[data-hid]').forEach(row => row.onclick = async e => {
    if (e.target.closest('[data-del]')) return;
    if (row.dataset.open === 'true') S = await window.dshift.activateTab(row.dataset.hid);
    else S = await window.dshift.historyOpen(row.dataset.hid);
    closePops(); renderAll();
  });
  $('#histList').querySelectorAll('[data-del]').forEach(b => b.onclick = async e => { e.stopPropagation(); await window.dshift.historyDelete(b.dataset.del); renderHistory($('#histSearch').value.toLowerCase()); });
}
$('#histSearch').addEventListener('input', e => renderHistory(e.target.value.trim().toLowerCase()));

let fbJpeg = null;
async function openFeedback() {
  closePops(); const cap = await window.dshift.feedbackCapture().catch(() => null);
  fbJpeg = cap?.jpegBase64 || null;
  if (cap?.dataUrl) { $('#fbShot').src = cap.dataUrl; $('#fbShotRow').classList.remove('hidden'); } else $('#fbShotRow').classList.add('hidden');
  $('#feedbackPop').classList.remove('hidden'); $('#fbNote').focus();
}
$('#fbCancel').onclick = () => closePops();
$('#fbSend').onclick = async () => { await window.dshift.feedbackSave($('#fbNote').value, $('#fbInclude').checked ? fbJpeg : null); $('#fbNote').value = ''; closePops(); };
$('#fbNote').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#fbSend').click(); } }); // his feedback saves on Cmd+Return

async function openSettings() {
  closePops(); const { settings } = await window.dshift.getState(); SETTINGS = settings;
  $('#setProvider').value = settings.provider; $('#setEffort').value = settings.effort;
  $('#setBudget').value = settings.budgetUSDPerDay || 0; $('#setKey').value = '';
  $('#setDenylist').value = (settings.denylist || []).join(', ');
  $('#setPaths').textContent = `Data: ${settings.dataDir} · Memory: ${settings.memoryDir} · Codex: ${settings.codex?.found ? settings.codex.version : 'not installed'} · API key source: ${settings.keySources?.[settings.provider] || 'none'} · Spent today: $${settings.spentToday ?? 0} · ${settings.hook?.detail || ''}`;
  $('#settingsPop').classList.remove('hidden');
}
$('#setClose').onclick = () => closePops();
$('#setOpenMemory').onclick = () => window.dshift.openMemory();
$('#setSave').onclick = async () => {
  const provider = $('#setProvider').value;
  await window.dshift.saveSettings({ provider, effort: $('#setEffort').value, budgetUSDPerDay: parseFloat($('#setBudget').value) || 0, denylist: $('#setDenylist').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) });
  const key = $('#setKey').value.trim(); if (key) await window.dshift.setKey(provider, key);
  closePops(); await refresh();
};

async function openMemory() {
  closePops(); const { files, audit, overview } = await window.dshift.listMemory();
  const ul = $('#memFiles'); ul.innerHTML = '';
  for (const f of files) { const li = document.createElement('li'); li.textContent = f; li.onclick = async () => { memSel = f; [...ul.children].forEach(c => c.classList.remove('sel')); li.classList.add('sel'); $('#memText').value = await window.dshift.readMemory(f); }; ul.appendChild(li); }
  const guardWarn = overview?.meOverGuard ? `⚠ me.md is ${overview.meChars} chars — past the 8,000-char guard it taxes every request. Trim it. ` : '';
  $('#memAudit').textContent = guardWarn + (audit.length ? 'Recent memory writes: ' + audit.slice(-5).map(a => `${a.rel} (${a.mode}, ${a.source})`).join(' · ') : 'No memory writes logged yet.');
  $('#memoryPop').classList.remove('hidden');
}
$('#memSave').onclick = async () => { if (memSel) await window.dshift.writeMemory(memSel, $('#memText').value); };
$('#memUndo').onclick = async () => { if (memSel) { await window.dshift.undoMemory(memSel); $('#memText').value = await window.dshift.readMemory(memSel); } };
$('#memOpenFolder').onclick = () => window.dshift.openMemory();
$('#memClose').onclick = () => closePops();

/* ---------- setup view ---------- */
$('#setupKey').addEventListener('input', () => { $('#setupSave').disabled = !$('#setupKey').value.trim(); });
$('#setupKey').addEventListener('keydown', e => { if (e.key === 'Enter' && $('#setupKey').value.trim()) $('#setupSave').click(); });
$('#setupGetKey').onclick = e => { e.preventDefault(); window.dshift.openExternal(SETTINGS?.provider === 'openai' ? 'https://platform.openai.com/api-keys' : 'https://console.anthropic.com/settings/keys'); };
$('#setupSave').onclick = async () => {
  try { await window.dshift.setKey(SETTINGS.provider, $('#setupKey').value.trim()); $('#setupKey').value = ''; $('#setupError').classList.add('hidden'); await refresh(); }
  catch { $('#setupError').classList.remove('hidden'); }
};

(async () => { applyZoom(); const s = await window.dshift.getState(); S = s.state; SETTINGS = s.settings; const a = await window.dshift.getAuto().catch(() => ({ auto: false })); if (a.auto) { autoOn = true; $('#autoHint').classList.add('on'); $('#autoText').textContent = 'auto mode on'; $('#autoIcon').textContent = '⏩'; $('#inputCard').classList.add('auto'); } renderAll(); ta.focus(); })();
