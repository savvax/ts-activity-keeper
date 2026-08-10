#!/usr/bin/env node
// prebuild-хук: гарантирует, что src/build-config.js существует и содержит
// токен бота. Приоритет: ENV (для CI) -> уже существующий файл -> интерактивный
// вопрос в терминале. Без токена сборка прерывается — собранное приложение
// без него неуправляемо.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const TARGET = path.join(__dirname, '..', 'src', 'build-config.js');

function write(token, secret) {
    const body = `// Сгенерировано build/prepare-secrets.js — не коммитить.\n`
        + `module.exports = {\n`
        + `    TELEGRAM_BOT_TOKEN: ${JSON.stringify(token)},\n`
        + `    PAIRING_SECRET: ${JSON.stringify(secret)},\n`
        + `};\n`;
    fs.writeFileSync(TARGET, body, { mode: 0o600 });
}

function mask(token) {
    if (token.length <= 8) return '***';
    return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function readExisting() {
    try {
        delete require.cache[require.resolve(TARGET)];
        const cfg = require(TARGET);
        return {
            token: String(cfg.TELEGRAM_BOT_TOKEN || '').trim(),
            secret: String(cfg.PAIRING_SECRET || '').trim(),
        };
    } catch (e) {
        return { token: '', secret: '' };
    }
}

function ask(rl, question) {
    return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

async function main() {
    const envToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const envSecret = String(process.env.TELEGRAM_SECRET || '').trim();

    if (envToken) {
        const secret = envSecret || crypto.randomBytes(8).toString('hex');
        write(envToken, secret);
        console.log(`[secrets] токен из ENV: ${mask(envToken)}`);
        console.log(`[secrets] ключ привязки: ${secret}`);
        return;
    }

    const existing = readExisting();
    if (existing.token) {
        console.log(`[secrets] использую src/build-config.js: ${mask(existing.token)}`);
        console.log(`[secrets] ключ привязки: ${existing.secret}`);
        return;
    }

    if (!process.stdin.isTTY) {
        console.error('[secrets] нет токена: задай TELEGRAM_BOT_TOKEN или запусти сборку в терминале');
        process.exit(1);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const token = await ask(rl, 'Telegram bot token (от @BotFather): ');
        if (!token) {
            console.error('[secrets] токен обязателен — сборка прервана');
            process.exit(1);
        }
        const answered = await ask(rl, 'Ключ привязки для /start (Enter — сгенерировать): ');
        const secret = answered || crypto.randomBytes(8).toString('hex');
        write(token, secret);
        console.log(`[secrets] записан src/build-config.js: ${mask(token)}`);
        console.log(`[secrets] ключ привязки: ${secret}  ← им активируется бот: /start ${secret}`);
    } finally {
        rl.close();
    }
}

main().catch((e) => {
    console.error('[secrets] ошибка:', e.message);
    process.exit(1);
});
