// User profile loader — reads ~/.claudia/user.json
// Provides per-user identity data (email, employee ID, etc.)
// Used by skills.js to replace {{user.*}} placeholders in skill templates.
//
// File format (~/.claudia/user.json):
// {
//   "email": "name.surname@company.com",
//   "jira_key": "name.surname",
//   "employee_id": "e999999",
//   "central_account": "E999999_CORP",
//   "entra_object_id": "uuid-here",
//   "full_name": "Surname, Name",
//   "company": "Company Name Ltd.",
//   "linkedin_slug": "name-surname-xxxxxx",
//   "home_dir": "C:/Users/e999999"          // optional, auto-detected
//   "email_encoded": "auto-derived"          // auto-computed from email
// }

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const USER_PROFILE_PATH = join(homedir(), '.claudia', 'user.json');

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 30000; // Reload every 30s max

const REQUIRED_FIELDS = ['email'];

/**
 * Load user profile from ~/.claudia/user.json.
 * Returns the parsed object or null if not found.
 * Results are cached for 30 seconds.
 */
export function loadUserProfile() {
  const now = Date.now();
  if (_cache !== undefined && (now - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }

  try {
    const raw = readFileSync(USER_PROFILE_PATH, 'utf8');
    const profile = JSON.parse(raw);

    // Warn about missing required fields (once)
    if (!loadUserProfile._checkedFields) {
      const missing = REQUIRED_FIELDS.filter(f => !profile[f]);
      if (missing.length) {
        console.error(`⚠ user.json is missing required fields: ${missing.join(', ')}`);
      }
      loadUserProfile._checkedFields = true;
    }

    _cache = profile;
    _cacheTs = now;
    return _cache;
  } catch {
    _cache = null;
    _cacheTs = now;
    return null;
  }
}

/**
 * Get a specific user profile field.
 * Returns the value or the fallback if not found.
 */
export function getUserField(key, fallback = null) {
  const profile = loadUserProfile();
  if (!profile) return fallback;
  return profile[key] !== undefined ? profile[key] : fallback;
}

/**
 * Get the user profile path for documentation.
 */
export function getUserProfilePath() {
  return USER_PROFILE_PATH;
}
