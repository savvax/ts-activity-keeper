const { test } = require('node:test');
const assert = require('node:assert');
const { createTelegramBot } = require('../src/telegram-bot');

// Fake Telegram API: queue of getUpdates payloads + capture of sendMessage.
function harness(opts = {}) {
  const updatesQueue = opts.updates || [];
  const sent = [];
  const calls = [];
  let chatId = opts.chatId || '';
  let token = opts.token != null ? opts.token : '123:abc';
  const handlers = {
    status: async () => 'STATUS TEXT',
    pause: async () => calls.push('pause'),
    resume: async () => calls.push('resume'),
    logout: async () => calls.push('logout'),
    quit: async () => calls.push('quit'),
    revoke: async () => { calls.push('revoke'); token = ''; },
    ...opts.handlers,
  };
  const bot = createTelegramBot({
    request: async (cfg) => {
      if (cfg.url.endsWith('/sendMessage')) {
        sent.push(cfg.data);
        return { data: { ok: true } };
      }
      if (cfg.url.endsWith('/getUpdates')) {
        const result = updatesQueue.shift() || [];
        return { data: { ok: true, result } };
      }
      return { data: { ok: false } };
    },
    getToken: () => token,
    getChatId: () => chatId,
    bindChatId: (id) => { chatId = id; calls.push('bind:' + id); },
    handlers,
  });
  return { bot, sent, calls, getChatId: () => chatId, getToken: () => token };
}

const msg = (chatId, text, updateId = 1) => ({ update_id: updateId, message: { chat: { id: chatId }, text } });

test('unbound: first /start binds the chat and replies with help', async () => {
  const h = harness({ updates: [[msg(555, '/start')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.getChatId(), '555');
  assert.strictEqual(h.sent.length, 1);
  assert.match(h.sent[0].text, /Connected/);
});

test('unbound: non-/start messages are ignored', async () => {
  const h = harness({ updates: [[msg(555, '/status')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.getChatId(), '');
  assert.strictEqual(h.sent.length, 0);
});

test('bound: messages from foreign chats are silently ignored', async () => {
  const h = harness({ chatId: '555', updates: [[msg(666, '/quit')], [msg(666, '/status')]] });
  await h.bot.pollOnce();
  await h.bot.pollOnce();
  assert.strictEqual(h.sent.length, 0);
  assert.deepStrictEqual(h.calls, []);
});

test('/status replies with the handler text', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/status')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.sent[0].text, 'STATUS TEXT');
  assert.strictEqual(h.sent[0].chat_id, '555');
});

test('/pause and /resume dispatch to handlers', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/pause', 1), msg(555, '/resume', 2)]] });
  await h.bot.pollOnce();
  assert.deepStrictEqual(h.calls, ['pause', 'resume']);
  assert.strictEqual(h.sent.length, 2);
});

test('/quit confirms before invoking the quit handler', async () => {
  const order = [];
  const h = harness({
    chatId: '555',
    updates: [[msg(555, '/quit')]],
    handlers: { quit: async () => order.push('quit') },
  });
  await h.bot.pollOnce();
  assert.match(h.sent[0].text, /Quitting/);
  assert.deepStrictEqual(order, ['quit']);
});

test('/revoke confirms, stops polling and calls the revoke handler', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/revoke')]] });
  await h.bot.pollOnce();
  assert.match(h.sent[0].text, /disconnected/);
  assert.ok(h.calls.includes('revoke'));
  assert.strictEqual(h.getToken(), '');
  assert.strictEqual(h.bot.isRunning(), false);
});

test('commands are case-insensitive and tolerate @BotName suffix', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/STATUS@MyBot')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.sent[0].text, 'STATUS TEXT');
});

test('unknown command gets a help hint', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/dance')]] });
  await h.bot.pollOnce();
  assert.match(h.sent[0].text, /Unknown command/);
});

test('offset advances past processed updates', async () => {
  const seen = [];
  let chatId = '555';
  const bot = createTelegramBot({
    request: async (cfg) => {
      if (cfg.url.endsWith('/getUpdates')) {
        seen.push(cfg.data.offset);
        return { data: { ok: true, result: seen.length === 1 ? [msg(555, '/help', 41)] : [] } };
      }
      return { data: { ok: true } };
    },
    getToken: () => 't',
    getChatId: () => chatId,
    bindChatId: () => {},
    handlers: {},
  });
  await bot.pollOnce();
  await bot.pollOnce();
  assert.deepStrictEqual(seen, [0, 42]);
});

test('notify sends to the bound chat, no-op when unbound or token missing', async () => {
  const h = harness({ chatId: '555' });
  await h.bot.notify('hello');
  assert.deepStrictEqual(h.sent[0], { chat_id: '555', text: 'hello' });

  const unbound = harness({ chatId: '' });
  await unbound.bot.notify('hello');
  assert.strictEqual(unbound.sent.length, 0);

  const tokenless = harness({ chatId: '555', token: '' });
  await tokenless.bot.notify('hello');
  assert.strictEqual(tokenless.sent.length, 0);
});

test('pollOnce returns false on API failure', async () => {
  const bot = createTelegramBot({
    request: async () => ({ data: { ok: false } }),
    getToken: () => 't',
    getChatId: () => '',
    bindChatId: () => {},
    handlers: {},
  });
  assert.strictEqual(await bot.pollOnce(), false);
});
