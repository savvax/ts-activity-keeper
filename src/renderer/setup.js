const $ = (id) => document.getElementById(id);

$('saveBtn').onclick = async () => {
    const email = $('email').value.trim();
    const password = $('password').value;
    const err = $('error');
    err.textContent = '';

    if (!email || !password) {
        err.textContent = 'Fill in email and password';
        return;
    }

    $('saveBtn').disabled = true;
    $('saveBtn').textContent = 'Saving…';
    try {
        const ok = await window.electronAPI.saveCredentials(email, password);
        if (ok) {
            $('saveBtn').textContent = 'Done';
        } else {
            throw new Error('save failed');
        }
    } catch (e) {
        $('saveBtn').disabled = false;
        $('saveBtn').textContent = 'Save and start';
        err.textContent = 'Could not save. Please try again.';
    }
};

$('password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('saveBtn').click();
});
