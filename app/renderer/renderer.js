'use strict';
/* D Shift renderer — tabs, streaming transcript, usage bar, queue,
   Codex approval card, settings, in-app memory editor. */
const $ = s => document.querySelector(s);
const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'gpt-5', 'gpt-5-mini', 'ollama:llama3.1'];
let S = null, busy = false, streamEl = null, curApproval = null, memSel = null;

async function refresh(patch) { S = patch || (await window.dshift.getState()).state; render(); }
function activeTab() { return S?.tabs.find(t => t.id === S.activeId) || S?.tabs[0]; }

function render() {
  if (!S) return;
  const tabs = $('#tabs'); tabs.innerHTML = '';
  for (const t of S.tabs) {
    const el = document.createElement('div'); el.className = 'tab' + (t.id === S.activeId ? ' active' : '');
    el.innerHTML = ''; el.textContent = t.title;
    const x = document.createElement('span'); x.className = 'x'; x.textContent = ' ✕';
    x.onclick = async ev => { ev.stopPropagation(); await refresh(await window.dshift.closeTab(t.id)); };
    el.appendChild(x);
    el.onclick = async () => { await refresh(await window.dshift.activateTab(t.id)); };
    tabs.appendChild(el);
  }
  const plus = document.createElement('button'); plus.textContent = '+'; plus.title = 'New tab (Ctrl+T)';
  plus.onclick = async () => refresh(await window.dshift.newTab()); tabs.appendChild(plus);

  const t = activeTab(); if (!t) return;
  const u = t.usage;
  $('#usagebar').textContent = `ctx ${Math.round(u.contextFraction * 100)}% · in ${fmt(u.input)} · out ${fmt(u.output)} · cache ${(u.cacheHitRate * 100).toFixed(0)}% hit · ~$${u.costUSD.toFixed(4)} · 📖 ${u.screenReads || 0} reads · 📷 ${u.screenshots || 0} shots`;
  const tr = $('#transcript'); tr.innerHTML = '';
  for (const m of t.display || []) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;

    const d = document.createElement('div'); d.className = 'msg ' + m.role; d.textContent = m.text || '';
    tr.appendChild(d);
  }
  const q = $('#queuebar'); q.innerHTML = '';
  for (const item of t.queue || []) { const d = document.createElement('div'); d.className = 'qitem'; d.textContent = '⏳ queued: ' + item.text; q.appendChild(d); }
  const sel = $('#modelSel'); sel.innerHTML = '';
  for (const m of MODELS) { const o = document.createElement('option'); o.value = m; o.textContent = m; if (m === t.model) o.selected = true; sel.appendChild(o); }
  tr.scrollTop = tr.scrollHeight;
}
const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);

async function send() {
  const ta = $('#input'); const q = ta.value.trim(); if (!q) return; ta.value = '';
  const t = activeTab(); if (!t) return;
  if (q === '/clear') { await refresh(await window.dshift.clearChat(t.id)); return; }
  if (busy) { // queue like the original: Enter queues, it runs after the reply
    t.queue = t.queue || []; t.queue.push({ text: q }); render(); return;
  }
  busy = true; $('#btnStop').classList.remove('hidden');
  await runSend(t.id, q);
  // drain queue
  for (;;) {
    const cur = activeTab(); const next = cur?.queue?.shift();
    if (!next) break; render(); await runSend(cur.id, next.text);
  }
  busy = false; $('#btnStop').classList.add('hidden');
}
async function runSend(tabId, q) {
  streamEl = null;
  await window.dshift.send(tabId, q);
  await refresh();
}
window.dshift.on('sidebar:shown', () => { $('#input').focus(); }); // typing must be one click-free step (audit B1 companion)
window.dshift.on('chat:delta', ({ tabId, delta }) => {
  if (tabId !== S?.activeId) return; // never draw a background tab's stream into the visible tab (audit M8)
  if (!streamEl) { streamEl = document.createElement('div'); streamEl.className = 'msg assistant'; $('#transcript').appendChild(streamEl); }
  streamEl.textContent += delta; $('#transcript').scrollTop = $('#transcript').scrollHeight;
});
window.dshift.on('chat:tool', t => {
  const d = document.createElement('div'); d.className = 'tool' + (t.status === 'error' ? ' error' : '');
  const icons = { read_screen: '📖 reading screen (accessibility)', take_screenshot: '📷 screenshot', search_memory: '🧠 searching memory', write_memory: '🧠 saving to memory', use_computer: '🤖 Codex task' };
  d.textContent = `${icons[t.name] || '🔧 ' + t.name} — ${t.status}`; $('#transcript').appendChild(d);
});
window.dshift.on('chat:error', ({ error }) => { const d = document.createElement('div'); d.className = 'msg error'; d.textContent = '⚠ ' + error; $('#transcript').appendChild(d); busy = false; $('#btnStop').classList.add('hidden'); });
window.dshift.on('state:patch', s => {
  S = s;
  if (busy) { // mid-stream patches only refresh the usage bar — a full re-render orphans the streaming bubble (audit M8)
    const t = activeTab(); if (t) { const u = t.usage; $('#usagebar').textContent = `ctx ${Math.round(u.contextFraction * 100)}% · in ${fmt(u.input)} · out ${fmt(u.output)} · cache ${(u.cacheHitRate * 100).toFixed(0)}% hit · ~$${u.costUSD.toFixed(4)} · 📖 ${u.screenReads || 0} reads · 📷 ${u.screenshots || 0} shots`; }
    return;
  }
  render();
});
window.dshift.on('ctx:update', c => { $('#ctxApp').textContent = c.app ? `· ${c.app}${c.title ? ' — ' + c.title : ''}${c.mode === 'denied' ? ' (no-read list)' : ''}` : ''; });
window.dshift.on('codex:approval', req => { curApproval = req.approvalId; $('#approvalTask').textContent = req.task; $('#approvalProgress').textContent = ''; $('#approval').classList.remove('hidden'); });
window.dshift.on('codex:progress', p => { if (curApproval) $('#approvalProgress').textContent = 'running: ' + p.text; });
window.dshift.on('ui:openSettings', openSettings);

$('#apprAllow').onclick = () => { window.dshift.codexDecision(true); $('#approval').classList.add('hidden'); curApproval = null; };
$('#apprDeny').onclick = () => { window.dshift.codexDecision(false); $('#approval').classList.add('hidden'); curApproval = null; };
$('#btnSend').onclick = send;
$('#btnStop').onclick = () => window.dshift.stop();
$('#input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 't' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.dshift.newTab().then(refresh); }
  if (e.key === 'w' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); const t = activeTab(); if (t) window.dshift.closeTab(t.id).then(refresh); }
});
$('#modelSel').onchange = async e => { const t = activeTab(); if (t) await refresh(await window.dshift.setTabModel(t.id, e.target.value)); };
$('#btnHide').onclick = () => window.close();
$('#btnSettings').onclick = openSettings;
$('#btnMemory').onclick = openMemory;
async function openSettings() {
  const { settings } = await window.dshift.getState();
  $('#setProvider').value = settings.provider; $('#setEffort').value = settings.effort;
  $('#setBudget').value = settings.budgetUSDPerDay || 0; $('#setKey').value = '';
  $('#setDenylist').value = (settings.denylist || []).join(', ');
  $('#setPaths').textContent = `Data: ${settings.dataDir} · Memory: ${settings.memoryDir} · Codex: ${settings.codex?.found ? settings.codex.version : 'not installed'} · API key source: ${settings.keySources?.[settings.provider] || 'none'} · Spent today: $${settings.spentToday ?? 0} · ${settings.hook?.detail || ''}`;
  const hint = $('#hint'); if (hint && settings.hook) hint.textContent = settings.hook.doubleShift ? 'double-tap ⇧ to toggle' : '⚠ double-Shift off — use Ctrl+Shift+Space';
  $('#settings').classList.remove('hidden');
}
$('#setClose').onclick = () => $('#settings').classList.add('hidden');
$('#setOpenMemory').onclick = () => window.dshift.openMemory();
$('#setSave').onclick = async () => {
  const provider = $('#setProvider').value;
  await window.dshift.saveSettings({ provider, effort: $('#setEffort').value, budgetUSDPerDay: parseFloat($('#setBudget').value) || 0, denylist: $('#setDenylist').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) });
  const key = $('#setKey').value.trim(); if (key) await window.dshift.setKey(provider, key);
  $('#settings').classList.add('hidden');
};
async function openMemory() {
  const { files, audit, overview } = await window.dshift.listMemory();
  const guardWarn = overview?.meOverGuard ? `⚠ me.md is ${overview.meChars} chars — past the 8,000-char guard it taxes every request. Trim it. ` : '';
  const ul = $('#memFiles'); ul.innerHTML = '';
  for (const f of files) { const li = document.createElement('li'); li.textContent = f; li.onclick = async () => { memSel = f; [...ul.children].forEach(c => c.classList.remove('sel')); li.classList.add('sel'); $('#memText').value = await window.dshift.readMemory(f); }; ul.appendChild(li); }
  $('#memAudit').textContent = guardWarn + (audit.length ? 'Recent memory writes: ' + audit.slice(-5).map(a => `${a.rel} (${a.mode}, ${a.source})`).join(' · ') : 'No memory writes logged yet.');
  $('#memoryDrawer').classList.remove('hidden');
}
$('#memSave').onclick = async () => { if (memSel) await window.dshift.writeMemory(memSel, $('#memText').value); };
$('#memUndo').onclick = async () => { if (memSel) { await window.dshift.undoMemory(memSel); $('#memText').value = await window.dshift.readMemory(memSel); } };
$('#memOpenFolder').onclick = () => window.dshift.openMemory();
$('#memClose').onclick = () => $('#memoryDrawer').classList.add('hidden');
(async () => { const s = await window.dshift.getState(); S = s.state; render(); })();
