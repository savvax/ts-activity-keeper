// Крутит почти бесшумный аудио-поток через встроенный `afplay`.
//
// Зачем: некоторые idle-logout-политики (в т.ч. кастомные корпоративные демоны)
// не считают сессию «бездействующей», пока играет звук/видео. Если демон
// `ai.tomorrowschool.idlelogout` именно такой — этот зацикленный тихий звук
// отменяет автовыход БЕЗ Accessibility и БЕЗ прав администратора (нужен только
// встроенный afplay). Если же демон завязан на HID idle — это не поможет
// (там нужна мышь, см. keep-awake); модуль всё равно безопасен и дешев, поэтому
// крутится всегда.
//
// Аудиофайл (низкоамплитудная синусоида, на слух неразличимая, но НЕ цифровой
// ноль — чтобы детекторы «активного аудиопотока» её видели) генерируется один
// раз в cachePath и переиспользуется. spawn/writeFileSync/setTimeout инжектятся
// — модуль теструется без Electron и без реального фс/аудио.

const DEFAULT_SECONDS = 60;
const DEFAULT_SAMPLE_RATE = 8000;

function buildSilentWav(
	seconds = DEFAULT_SECONDS,
	sampleRate = DEFAULT_SAMPLE_RATE,
) {
	const numSamples = sampleRate * seconds;
	const dataSize = numSamples * 2; // 16-bit mono
	const buf = Buffer.alloc(44 + dataSize);
	buf.write('RIFF', 0);
	buf.writeUInt32LE(36 + dataSize, 4);
	buf.write('WAVE', 8);
	buf.write('fmt ', 12);
	buf.writeUInt32LE(16, 16); // fmt subchunk size
	buf.writeUInt16LE(1, 20); // PCM
	buf.writeUInt16LE(1, 22); // mono
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
	buf.writeUInt16LE(2, 32); // block align
	buf.writeUInt16LE(16, 34); // bits per sample
	buf.write('data', 36);
	buf.writeUInt32LE(dataSize, 40);
	// Низкоамплитудная синусоида (~-50 дБ, неслышимо на динамиках ноутбука,
	// но ненулевой сигнал — CoreAudio видит активный поток рендера).
	const amp = 100; // из 32767
	const freq = 220;
	let offset = 44;
	for (let i = 0; i < numSamples; i++) {
		const v = Math.round(
			Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp,
		);
		buf.writeInt16LE(v, offset);
		offset += 2;
	}
	return buf;
}

function createSilentAudio({
	spawn,
	writeFileSync,
	cachePath,
	log = () => {},
	seconds = DEFAULT_SECONDS,
	sampleRate = DEFAULT_SAMPLE_RATE,
	setTimeoutFn = setTimeout,
	clearTimeoutFn = clearTimeout,
}) {
	let child = null;
	let relaunchTimer = null;
	let fileReady = false;
	let stopping = true;
	let lastSpawnAt = 0;

	function ensureFile() {
		if (fileReady) return;
		try {
			writeFileSync(cachePath, buildSilentWav(seconds, sampleRate));
			fileReady = true;
		} catch (e) {
			log('silent-audio: не удалось записать wav: ' + e.message);
			fileReady = false;
		}
	}

	function spawnPlayer() {
		if (stopping || !fileReady) return;
		try {
			child = spawn('afplay', ['-q', cachePath], { stdio: 'ignore' });
			lastSpawnAt = Date.now();
			child.on('exit', () => {
				child = null;
				if (stopping) return;
				// Нормальный проигрыш ~seconds; мгновенный выход = ошибка → бэкофф,
				// чтобы не закрутить tight-цикл респавна при стойкой проблеме.
				const ran = Date.now() - lastSpawnAt;
				const delay = ran < 1000 ? 5000 : 100;
				relaunchTimer = setTimeoutFn(spawnPlayer, delay);
			});
		} catch (e) {
			log('silent-audio: afplay не стартует: ' + e.message);
			relaunchTimer = setTimeoutFn(spawnPlayer, 5000);
		}
	}

	return {
		start() {
			ensureFile();
			if (!fileReady) return false;
			stopping = false;
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
	};
}

module.exports = {
	createSilentAudio,
	buildSilentWav,
	DEFAULT_SECONDS,
	DEFAULT_SAMPLE_RATE,
};
