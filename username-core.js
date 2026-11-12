/* BuffPrints — nickname rules shared by the app and its tests.
   Format only: moderation runs on the server (set_username / check_username),
   and its word lists are never sent to the browser. No DOM, no network. */
(function(root){
'use strict';

const MIN = 3, MAX = 24, CHANGE_DAYS = 7;
const FORMAT = /^[A-Za-z0-9_]{3,24}$/;

// The submitted value is checked exactly as typed: nothing is trimmed, case-folded
// or rewritten, so a name is never silently altered.
function formatOk(v){
  return typeof v === 'string' && FORMAT.test(v) && /[A-Za-z]/.test(v);
}

const MESSAGES = {
  guidelines:   'That username doesn’t meet our community guidelines. Choose another or use a suggested name.',
  taken:        'That name is taken. Try another or shuffle a new one.',
  format:       'Use 3–24 letters, numbers, or underscores, including at least one letter.',
  rate_limited: 'Too many tries — wait a minute, then try again.',
  unavailable:  'Couldn’t find a free suggestion. Shuffle again or create your own.',
  current:      'That’s already your nickname.',
  ok:           'Available',
  offline:      'You’re offline. Connect to choose a nickname.',
  error:        'Something went wrong. Try again.'
};

function changeDate(nextAt, locale){
  const d = new Date(nextAt);
  if (isNaN(d)) return 'in a few days';
  return d.toLocaleDateString(locale || undefined, {weekday: 'short', month: 'short', day: 'numeric'});
}

// Turn a server status (from check_username / set_username) into the text to show.
function message(res, locale){
  const st = res && res.status;
  if (st === 'too_soon') return 'You can change your nickname once every ' + CHANGE_DAYS + ' days. Next change: ' + changeDate(res.next_at, locale) + '.';
  return MESSAGES[st] || MESSAGES.error;
}

// Live hint while typing (format only; availability and moderation come from the server).
function typingHint(v){
  if (v == null || v === '') return null;
  return formatOk(v) ? null : MESSAGES.format;
}

// Who should see the picker: anyone with no nickname yet, or whose nickname an
// administrator asked them to change.
function needsPicker(profile){
  if (!profile) return false;
  return !profile.username || (profile.name_state && profile.name_state !== 'ok');
}

const REPORT_REASONS = [
  ['profanity',     'Profanity or obscene'],
  ['hate',          'Slur or hateful'],
  ['sexual',        'Sexual or sexually harassing'],
  ['threat',        'Threat, violence or self-harm taunt'],
  ['harassment',    'Bullying or insulting someone'],
  ['accusation',    'Accuses a real person or group'],
  ['impersonation', 'Pretends to be staff, police, or another student'],
  ['personal_info', 'Shares contact or personal details'],
  ['other',         'Something else']
];

const REPORT_MESSAGES = {
  ok:               'Thanks — a person will review it.',
  already_reported: 'You’ve already reported this name. It’s waiting for review.',
  self:             'That’s your own nickname. Change it under Progress → Account.',
  not_found:        'That nickname has changed since this list loaded.',
  rate_limited:     'You’ve sent a lot of reports today. Try again tomorrow.',
  invalid:          'Choose a reason and keep details under 280 characters.'
};

const REVIEW_MESSAGES = {
  ok:           'Request sent. You’ll see the result under Progress → Account.',
  already_open: 'You already have a request waiting for review.',
  not_needed:   'That name is allowed — you can use it now.',
  format:       MESSAGES.format,
  rate_limited: 'Too many requests today. Try again tomorrow.',
  invalid:      'Keep the note under 280 characters.'
};

const api = {MIN, MAX, CHANGE_DAYS, formatOk, typingHint, message, needsPicker, changeDate,
             MESSAGES, REPORT_REASONS, REPORT_MESSAGES, REVIEW_MESSAGES};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.RoamNames = api;
})(typeof window !== 'undefined' ? window : globalThis);
