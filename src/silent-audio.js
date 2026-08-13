// Крутит почти бесшумный аудио-поток через встроенный `afplay`, читая готовый
// silence.wav (поставляется в репозитории: resources/silence.wav, в бандл —
// через electron-builder extraResources, чтобы внешний afplay мог его открыть).
//
// Зачем: некоторые idle-logout-политики (в т.ч. кастомные корпоративные демоны)
// не считают сессию «бездействующей», пока играет звук/видео. Если демон
// `ai.tomorrowschool.idlelogout` именно такой — этот зацикленный тихий звук
// отменяет автовыход БЕЗ Accessibility и БЕЗ прав администратора (нужен только
// встроенный afplay). На HID-idle-демонах не поможет, но модуль безвреден.
//
// WAV один раз сгенерирован buildSilentWav() и лежит в репо; в рантайме файл
// не пересоздаётся — createSilentAudio получает готовый wavPath. spawn/setTimeout
// инжектятся — модуль тестируется без Electron и без реального аудио.

const DEFAULT_SECONDS = 60;
const DEFAULT_SAMPLE_RATE = 8000;

// Генерация WAV (низкоамплитудная синусоида, ~-50 дБ — на слух неразличимо, но
// НЕ цифровой ноль, чтобы CoreAudio видел активный поток). Экспортируется, чтобы
// (пере)генерировать resources/silence.wav скриптом и покрывать заголовок тестом.
function buildSilentWav(
	seconds = DEFAULT_SECONDS,
	sampleRate = DEFAULT_SAMPLE_RATE,
) {
	const numSamples = sampleRate * seconds;
	const dataSize = numSamples * 2; // 16-bit mono
	const buf = Buffer.alloc(44 + dataSize);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + dataSize, 4);
	buf.write("WAVE", 8);
	buf.write("fmt ", 12);
	buf.writeUInt32LE(16, 16); // fmt subchunk size
	buf.writeUInt16LE(1, 20); // PCM
	buf.writeUInt16LE(1, 22); // mono
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
	buf.writeUInt16LE(2, 32); // block align
	buf.writeUInt16LE(16, 34); // bits per sample
	buf.write("data", 36);
	buf.writeUInt32LE(dataSize, 40);
	const amp = 100; // из 32767
	const freq = 220;
	let offset = 44;
	for (let i = 0; i < numSamples; i++) {
		const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp);
		buf.writeInt16LE(v, offset);
		offset += 2;
	}
	return buf;
}

function createSilentAudio({
	spawn,
	wavPath,
	log = () => {},
	setTimeoutFn = setTimeout,
	clearTimeoutFn = clearTimeout,
}) {
	let child = null;
	let relaunchTimer = null;
	let stopping = true;
	let lastSpawnAt = 0;
	let loggedFastFail = false;

	function spawnPlayer() {
		if (stopping || !wavPath) return;
		try {
			// stderr ловим, чтобы увидеть, почему afplay падает на таргете
			// (на dev-машине wav+afplay работают — значит причина окружающая).
			child = spawn("afplay", ["-q", wavPath], {
				stdio: ["ignore", "ignore", "pipe"],
			});
			lastSpawnAt = Date.now();
			let stderrBuf = "";
			if (child.stderr) {
				child.stderr.on("data", (d) => {
					stderrBuf += d.toString();
				});
			}
			child.on("exit", (code) => {
				child = null;
				if (stopping) return;
				// Нормальный проигрыш ~seconds; мгновенный выход или ненулевой code =
				// ошибка → бэкофф, чтобы не закрутить tight-цикл респавна.
				const ran = Date.now() - lastSpawnAt;
				if (ran < 1000 || code !== 0) {
					if (!loggedFastFail) {
						loggedFastFail = true;
						log(
							"silent-audio: afplay упал (code=" +
								code +
								", ran=" +
								ran +
								"ms) wav=" +
								wavPath +
								(stderrBuf.trim() ? " stderr: " + stderrBuf.trim() : ""),
						);
					}
					relaunchTimer = setTimeoutFn(spawnPlayer, 5000);
				} else {
					loggedFastFail = false;
					relaunchTimer = setTimeoutFn(spawnPlayer, 100);
				}
			});
		} catch (e) {
			log("silent-audio: afplay не стартует: " + e.message);
			relaunchTimer = setTimeoutFn(spawnPlayer, 5000);
		}
	}

	return {
		start() {
			if (!wavPath) return false;
			stopping = false;
			loggedFastFail = false; // свежая попытка — логнуть ошибку заново, если будет
			if (child) return true; // уже крутится
			spawnPlayer();
			return true;
		},
		stop() {
			stopping = true;
			if (relaunchTimer != null) {
				clearTimeoutFn(relaunchTimer);
				relaunchTimer = null;
			}
			if (child) {
				try {
					child.kill();
				} catch {
					// best-effort
				}
				child = null;
			}
		},
		isActive() {
			return child != null;
		},
		isFailing() {
			return loggedFastFail;
		},
	};
}

module.exports = {
	createSilentAudio,
	buildSilentWav,
	DEFAULT_SECONDS,
	DEFAULT_SAMPLE_RATE,
};
