// Single source of truth for the upstream domain.
// Change BASE_DOMAIN here to point the app at a different deployment.
const BASE_DOMAIN = 'tomorrow-school.ai';

// Default dashboard base URL (overridable via DASHBOARD_URL env var in src/main.js).
const DEFAULT_DASHBOARD_URL = `https://dashboard.${BASE_DOMAIN}`;

// Gitea OAuth endpoint used by the API tracking backend.
const GITEA_URL = `https://01.${BASE_DOMAIN}/git`;

module.exports = { BASE_DOMAIN, DEFAULT_DASHBOARD_URL, GITEA_URL };
