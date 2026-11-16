import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scanHistory } from '../src/scan.mjs';
import { normalizeConfig } from '../src/schema.mjs';

function fakeQuery(sessions) {
  return {
    async filterSessions() {
      return sessions.map((session) => ({ header: { id: session.id, cwd: session.cwd } }));
    },
    async filterEvents(sessionId) {
      const session = sessions.find((entry) => entry.id === sessionId);
      return session.messages.map((message, index) => ({
        seq: index,
        type: message.role === 'user' ? 'user/message' : 'assistant/message',
        time: Date.now(),
        surface: 'current',
        text: message.text,
      }));
    },
  };
}

const config = normalizeConfig({ scanDays: 7, scanMaxSessions: 10 });

test('scanHistory pairs user corrections with the assistant message above them', async () => {
  const query = fakeQuery([{
    id: 's1',
    cwd: 'C:/ws',
    messages: [
      { role: 'assistant', text: '我用 npm 装好了。' },
      { role: 'user', text: '以后都用 pnpm 装依赖' },
      { role: 'assistant', text: '好的。' },
      { role: 'user', text: '帮我看看日志' },
    ],
  }]);
  const found = [];
  const stats = await scanHistory({
    query,
    config,
    onSignal: (signal) => {
      found.push(signal);
      return true;
    },
  });
  assert.equal(stats.ok, true);
  assert.equal(stats.sessions, 1);
  assert.equal(stats.signals, 1);
  assert.equal(found[0].userText, '以后都用 pnpm 装依赖');
  assert.equal(found[0].assistantText, '我用 npm 装好了。');
  assert.equal(found[0].workspace, 'C:/ws');
});

test('scanHistory degrades without the service', async () => {
  const stats = await scanHistory({ query: null, config, onSignal: () => true });
  assert.equal(stats.ok, false);
  assert.equal(stats.reason, 'no-session-query');
});

test('scanHistory survives one unreadable session', async () => {
  const query = {
    async filterSessions() {
      return [{ header: { id: 'bad' } }, { header: { id: 'good', cwd: 'C:/ws' } }];
    },
    async filterEvents(sessionId) {
      if (sessionId === 'bad') throw new Error('replay failed');
      return [{
        seq: 1,
        type: 'user/message',
        time: Date.now(),
        text: '以后都用 pnpm 装依赖',
      }];
    },
  };
  const stats = await scanHistory({ query, config, onSignal: () => true });
  assert.equal(stats.ok, true);
  assert.equal(stats.signals, 1);
});

test('scanHistory skips delegated subagent sessions', async () => {
  const query = {
    async filterSessions() {
      return [
        { header: { id: 'sub', cwd: 'C:/ws', origin: 'subagent' } },
        { header: { id: 'main', cwd: 'C:/ws' } },
      ];
    },
    async filterEvents(sessionId) {
      return [{ seq: 1, type: 'user/message', time: Date.now(), text: '以后都用 pnpm' }];
    },
  };
  const stats = await scanHistory({ query, config, onSignal: () => true });
  assert.equal(stats.sessions, 1);
  assert.equal(stats.signals, 1);
});