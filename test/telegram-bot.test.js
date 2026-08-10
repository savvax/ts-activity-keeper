const { test } = require('node:test');
const assert = require('node:assert');
const { createTelegramBot } = require('../src/telegram-bot');

// Фейковый Telegram API: очередь ответов getUpdates + перехват sendMessage.
function harness(opts = {}) {
  const updatesQueue = opts.updates || [];
  const sent = [];
  const calls = [];
  let chatId = opts.chatId || '';
  const token = opts.token != null ? opts.token : '123:abc';
  const secret = opts.secret != null ? opts.secret : 'hunter2';
  const handlers = {
    status: async () => 'STATUS TEXT',
    login: async (email, password) => { calls.push(`login:${email}:${password}`); return 'logged in'; },
    logout: async () => { calls.push('logout'); return 'logged out'; },
    pause: async () => { calls.push('pause'); return 'paused'; },
    resume: async () => { calls.push('resume'); return 'resumed'; },
    autostop: async (minutes, logout) => { calls.push(`autostop:${minutes}:${logout}`); return 'autostop set'; },
    autostart: async (on) => { calls.push(`autostart:${on}`); return 'autostart set'; },
    remind: async (minutes) => { calls.push(`remind:${minutes}`); return 'remind set'; },
    hidelogin: async () => { calls.push('hidelogin'); return 'masked'; },
    quit: async () => { calls.push('quit'); },
    ...opts.handlers,
  };
  const bot = createTelegramBot({
    request: async (cfg) => {
      if (cfg.url.endsWith('/sendMessage')) {
        sent.push(cfg.data);
        return { data: { ok: true } };
      }
      if (cfg.url.endsWith('/getUpdates')) {
        return { data: { ok: true, result: updatesQueue.shift() || [] } };
      }
      return { data: { ok: false } };
    },
    getToken: () => token,
    getSecret: () => secret,
    getChatId: () => chatId,
    bindChatId: (id) => { chatId = id; calls.push('bind:' + id); },
    handlers,
  });
  return { bot, sent, calls, getChatId: () => chatId };
}

const msg = (chatId, text, updateId = 1) =>
  ({ update_id: updateId, message: { chat: { id: chatId }, text } });

test('непривязанный чат: /start с верным ключом привязывает и шлёт help', async () => {
  const h = harness({ updates: [[msg(555, '/start hunter2')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.getChatId(), '555');
  assert.match(h.sent[0].text, /\/status/);
});

test('непривязанный чат: /start без ключа или с неверным — отказ без привязки', async () => {
  const h = harness({ updates: [[msg(555, '/start')], [msg(555, '/start wrong')]] });
  await h.bot.pollOnce();
  await h.bot.pollOnce();
  assert.strictEqual(h.getChatId(), '');
  assert.strictEqual(h.sent.length, 2);
  assert.match(h.sent[0].text, /ключ/i);
  assert.match(h.sent[1].text, /ключ/i);
});

test('непривязанный чат: прочие команды игнорируются молча', async () => {
  const h = harness({ updates: [[msg(555, '/status')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.sent.length, 0);
  assert.strictEqual(h.getChatId(), '');
});

test('пустой ключ в сборке не даёт привязать чат', async () => {
  const h = harness({ secret: '', updates: [[msg(555, '/start')], [msg(555, '/start ')]] });
  await h.bot.pollOnce();
  await h.bot.pollOnce();
  assert.strictEqual(h.getChatId(), '');
});

test('привязанный чат: чужие чаты игнорируются молча', async () => {
  const h = harness({ chatId: '555', updates: [[msg(666, '/quit'), msg(666, '/start hunter2')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.sent.length, 0);
  assert.deepStrictEqual(h.calls, []);
});

test('/status отвечает текстом хендлера', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/status')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.sent[0].text, 'STATUS TEXT');
  assert.strictEqual(h.sent[0].chat_id, '555');
});

test('/login передаёт email и пароль, отвечает текстом хендлера', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/login me@ts.ru p@ss word')]] });
  await h.bot.pollOnce();
  assert.deepStrictEqual(h.calls, ['login:me@ts.ru:p@ss word']);
  assert.strictEqual(h.sent[0].text, 'logged in');
});

test('/login с плохими аргументами не зовёт хендлер, а объясняет формат', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/login me@ts.ru')]] });
  await h.bot.pollOnce();
  assert.deepStrictEqual(h.calls, []);
  assert.match(h.sent[0].text, /Формат/);
});

test('/autostop разбирает минуты и logout', async () => {
  const h = harness({
    chatId: '555',
    updates: [[msg(555, '/autostop 90 logout', 1), msg(555, '/autostop off', 2), msg(555, '/autostop abc', 3)]],
  });
  await h.bot.pollOnce();
  assert.deepStrictEqual(h.calls, ['autostop:90:true', 'autostop:0:false']);
  assert.match(h.sent[2].text, /Формат/);
});

test('/autostart и /remind разбирают аргументы', async () => {
  const h = harness({
    chatId: '555',
    updates: [[msg(555, '/autostart on', 1), msg(555, '/remind off', 2), msg(555, '/autostart', 3)]],
  });
  await h.bot.pollOnce();
  assert.deepStrictEqual(h.calls, ['autostart:true', 'remind:0']);
  assert.match(h.sent[2].text, /Формат/);
});

test('/pause, /resume, /logout, /hidelogin дергают свои хендлеры', async () => {
  const h = harness({
    chatId: '555',
    updates: [[msg(555, '/pause', 1), msg(555, '/resume', 2), msg(555, '/logout', 3), msg(555, '/hidelogin', 4)]],
  });
  await h.bot.pollOnce();
  assert.deepStrictEqual(h.calls, ['pause', 'resume', 'logout', 'hidelogin']);
  assert.deepStrictEqual(h.sent.map((s) => s.text), ['paused', 'resumed', 'logged out', 'masked']);
});

test('/quit предупреждает до выхода', async () => {
  const order = [];
  const h = harness({
    chatId: '555',
    updates: [[msg(555, '/quit')]],
    handlers: { quit: async () => order.push('quit') },
  });
  await h.bot.pollOnce();
  assert.match(h.sent[0].text, /Мак/);
  assert.deepStrictEqual(order, ['quit']);
});

test('/revoke больше не существует', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/revoke')]] });
  await h.bot.pollOnce();
  assert.match(h.sent[0].text, /Неизвестная команда/);
});

test('команды регистронезависимы и терпят суффикс @BotName', async () => {
  const h = harness({ chatId: '555', updates: [[msg(555, '/STATUS@MyBot')]] });
  await h.bot.pollOnce();
  assert.strictEqual(h.sent[0].text, 'STATUS TEXT');
});

test('offset сдвигается за обработанные апдейты', async () => {
  const seen = [];
  const bot = createTelegramBot({
    request: async (cfg) => {
      if (cfg.url.endsWith('/getUpdates')) {
        seen.push(cfg.data.offset);
        return { data: { ok: true, result: seen.length === 1 ? [msg(555, '/help', 41)] : [] } };
      }
      return { data: { ok: true } };
    },
    getToken: () => 't',
    getSecret: () => 's',
    getChatId: () => '555',
    bindChatId: () => {},
    handlers: {},
  });
  await bot.pollOnce();
  await bot.pollOnce();
  assert.deepStrictEqual(seen, [0, 42]);
});

test('notify шлёт в привязанный чат и молчит без чата или токена', async () => {
  const h = harness({ chatId: '555' });
  await h.bot.notify('привет');
  assert.deepStrictEqual(h.sent[0], { chat_id: '555', text: 'привет' });

  const unbound = harness({ chatId: '' });
  await unbound.bot.notify('привет');
  assert.strictEqual(unbound.sent.length, 0);

  const tokenless = harness({ chatId: '555', token: '' });
  await tokenless.bot.notify('привет');
  assert.strictEqual(tokenless.sent.length, 0);
});

test('pollOnce возвращает false при отказе API', async () => {
  const bot = createTelegramBot({
    request: async () => ({ data: { ok: false } }),
    getToken: () => 't',
    getSecret: () => 's',
    getChatId: () => '',
    bindChatId: () => {},
    handlers: {},
  });
  assert.strictEqual(await bot.pollOnce(), false);
});
