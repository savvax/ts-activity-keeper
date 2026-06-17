const $ = (id) => document.getElementById(id);

window.electronAPI.onStateUpdate(updateUI);
window.electronAPI.getState().then(updateUI);

function updateUI(s) {
    $('status').textContent = s.status;
    $('status').style.color = statusColor(s.status);
    $('statusDot').style.background = statusColor(s.status);
    $('duration').textContent = s.duration;
    $('today').textContent = s.today || '--:--:--';
    $('week').textContent = s.week || '--:--:--';
    $('email').textContent = s.email || '-';
    $('action').textContent = s.action || '-';

    const challenge = $('challenge');
    if (s.challenge) challenge.classList.remove('hidden');
    else challenge.classList.add('hidden');

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
    if (s === 'Active') return '#34c759';
    if (s === 'Not counting') return '#ff8a00';
    if (s === 'Stopped') return '#999';
    if (s === 'Starting...') return '#ff9500';
    if (s.startsWith('Error')) return '#ff3b30';
    return '#ff9500';
}

$('quitBtn').onclick = () => window.electronAPI.quit();
$('logoutBtn').onclick = () => window.electronAPI.logout();
$('loginBtn').onclick = () => window.electronAPI.showLogin();

window.electronAPI.getSettings().then((s) => {
    $('soundToggle').checked = s.notifySound;
    $('reminderMinutes').value = s.notifyReminderMinutes;
});
$('soundToggle').onchange = (e) =>
    window.electronAPI.saveSettings({ notifySound: e.target.checked });
$('reminderMinutes').onchange = (e) =>
    window.electronAPI.saveSettings({ notifyReminderMinutes: e.target.value });
