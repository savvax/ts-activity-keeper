// Resolves the shared config.json path. Lazy `require('electron')` so sibling
// modules that import this don't pull in Electron at unit-test time.
const path = require('path');

function configPath() {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'config.json');
}

module.exports = { configPath };
