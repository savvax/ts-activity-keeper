const $ = (id) => document.getElementById(id);

window.electronAPI.onStateUpdate(updateUI);
window.electronAPI.getState().then(updateUI);

function updateUI(s) {
    $('status').textContent = s.status;
    document.documentElement.style.setProperty('--status', statusColor(s.status));
    $('statusPill').classList.toggle('live', s.status === 'Active');
    $('duration').textContent = s.duration;
    $('today').textContent = s.today || '--:--:--';
    $('week').textContent = s.week || '--:--:--';
    $('email').textContent = s.email || '-';
    $('action').textContent = s.action || '-';

    $('challenge').classList.toggle('hidden', !s.challenge);

    const autoStopRow = $('autoStopRow');
    if (s.autoStopRemaining) {
        autoStopRow.classList.remove('hidden');
        $('autoStopRemaining').textContent = s.autoStopRemaining;
    } else {
        autoStopRow.classList.add('hidden');
    }

    $('tgDot').classList.toggle('linked', !!s.telegramLinked);
    $('tgHint').textContent = s.telegramLinked
        ? 'Linked. Send /help to your bot for commands; /revoke disconnects it.'
        : 'Paste a bot token, then send /start to your bot to link it. Clear the field (or send /revoke) to disconnect.';

    const loggedIn = !!(s.email && s.email !== '-');
    const active = s.status === 'Active' || s.status === 'Starting...' || s.status === 'Not counting';
    const btn = $('mainBtn');
    btn.textContent = active ? 'Stop' : 'Start';
    btn.className = active ? 'btn btn-stop' : 'btn btn-start';
    btn.onclick = active
        ? () => window.electronAPI.stopBot()
        : () => window.electronAPI.startBot();

    // Logged out: only offer "Sign in". Logged in: tracking + "Sign out".
    $('mainBtn').style.display = loggedIn ? '' : 'none';
    $('logoutBtn').style.display = loggedIn ? '' : 'none';
    $('loginBtn').style.display = loggedIn ? 'none' : '';
}

function statusColor(s) {
    if (s === 'Active') return '#30a14e';
    if (s === 'Not counting') return '#ff9500';
    if (s === 'Stopped') return '#8e8e93';
    if (s.startsWith('Error')) return '#e5484d';
    return '#ff9500'; // Starting... and anything transitional
}

$('quitBtn').onclick = () => window.electronAPI.quit();
$('logoutBtn').onclick = () => window.electronAPI.logout();
$('loginBtn').onclick = () => window.electronAPI.showLogin();

function applySettings(s) {
    $('soundToggle').checked = s.notifySound;
    $('reminderMinutes').value = s.notifyReminderMinutes;
    $('autoStopMinutes').value = s.autoStopMinutes;
    $('autoStopLogout').checked = s.autoStopLogout;
    if (document.activeElement !== $('telegramToken')) {
        $('telegramToken').value = s.telegramToken || '';
    }
    $('autoStopMode').textContent = s.autoStopLogout ? ' → log out' : '';
    // Hide-login is one-way: once enabled the control disappears for good.
    if (s.hideLogin) {
        $('hideLoginRow').classList.add('hidden');
        $('hideLoginHint').textContent = 'Login is hidden. This cannot be undone.';
    }
}

window.electronAPI.getSettings().then(applySettings);

async function save(patch) {
    const saved = await window.electronAPI.saveSettings(patch);
    applySettings(saved);
    const state = await window.electronAPI.getState();
    updateUI(state);
}

$('soundToggle').onchange = (e) => save({ notifySound: e.target.checked });
$('reminderMinutes').onchange = (e) => save({ notifyReminderMinutes: e.target.value });
$('autoStopMinutes').onchange = (e) => save({ autoStopMinutes: e.target.value });
$('autoStopLogout').onchange = (e) => save({ autoStopLogout: e.target.checked });
$('telegramToken').onchange = (e) => save({ telegramToken: e.target.value });

$('hideLoginToggle').onchange = (e) => {
    if (!e.target.checked) return;
    const sure = confirm('Hide the login permanently? It cannot be revealed again from the app.');
    if (!sure) { e.target.checked = false; return; }
    save({ hideLogin: true });
};
