'use strict';
/* UI-parity support tests: chat archive (his History) + image attachments (his appshot/paste/drop). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dshift-parity-'));
const { ChatStore } = require('../src/chatStore');
const { runTurn } = require('../src/agent');
const { MemoryStore } = require('../src/memory');

test('archive: closing a tab with content saves it; history reopens and deletes it', () => {
  const dir = tmp(); const s = new ChatStore(dir); const t = s.get();
  s.addDisplay(t, { role: 'user', text: 'a question worth keeping' });
  s.addDisplay(t, { role: 'assistant', text: 'an answer' });
  const t2 = s.newTab(); // second tab so close doesn't hide the sidebar logic path
  s.closeTab(t.id);
  const list = s.listArchive();
  assert.equal(list.length, 1); assert.match(list[0].preview, /worth keeping/);
  const reopened = s.openArchived(t.id);
  assert.equal(reopened.display.length, 2);
  assert.equal(s.listArchive().length, 0);
  s.closeTab(reopened.id); // archives again
  assert.equal(s.listArchive().length, 1);
  s.deleteArchived(t.id); assert.equal(s.listArchive().length, 0);
  assert.ok(t2); // silence
});
test('archive: empty tabs are not archived', () => {
  const dir = tmp(); const s = new ChatStore(dir); const t = s.get(); s.newTab();
  s.closeTab(t.id); assert.equal(s.listArchive().length, 0);
});
test('attachments: images ride the first user turn as image blocks', async () => {
  const dir = tmp(); const memory = new MemoryStore(dir).seed();
  let posted = null;
  const host = { memory, getContext: async () => ({ app: 'chrome', title: 'chart', text: 'page text' }), takeScreenshot: async () => ({ text: 's' }), requestCodexApproval: async () => ({ text: 'ok' }), onUsage: () => {}, callLLM: async ({ messages }) => { posted = messages; return { text: 'nice chart', toolUses: [], usage: { input: 1, output: 1 }, stopReason: 'end_turn' }; } };
  const tab = { id: 'x', title: 'New chat', model: 'm', messages: [], display: [], queue: [] };
  await runTurn({ tab, question: 'what does this show?', images: ['JPEGDATA'], host });
  const first = posted[0];
  assert.ok(Array.isArray(first.content));
  const img = first.content.find(b => b.type === 'image');
  assert.equal(img.source.data, 'JPEGDATA'); assert.equal(img.source.media_type, 'image/jpeg');
  assert.match(first.content[first.content.length - 1].text, /what does this show/);
});
