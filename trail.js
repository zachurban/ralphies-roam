/* You've Got Trail. Supabase checks proximity before releasing the encrypted note. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const core = window.HerdCore;
  const form = $('compose');
  const cfg = window.RR_CONFIG || {};
  const ready = cfg.supabaseUrl && cfg.supabaseKey && window.crypto?.subtle;
  const dateFormat = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeZone: 'America/Denver'
  });

  const timeFormat = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  });
  const params = new URLSearchParams(location.search);
  const inApp = window.parent !== window && params.has('tab');
  const library = window.TrailSaved;
  const refreshSaved = library.mount({
    getClient: () => inApp ? window.parent.BPTrailClient?.() : null,
    signIn: () => window.parent.BPTrailSignIn?.(),
    dateFormat
  });

  const fragment = new URLSearchParams(location.hash.slice(1));
  const id = fragment.get('trail') || '';
  const key = fragment.get('key') || '';
  const deletion = fragment.get('delete') || '';
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  let pendingSave;
  let selectedStop;
  let picker;
  let saving = false;
  let hiddenAt;
  let revealedNote;
  let composerStarted = false;
  let composerStage = 'compose';

  const status = message => { $('trailStatus').textContent = message; };
  const unavailable = 'This clue link is invalid, expired, or has been deleted.';

  async function rpc(name, body) {
    const response = await fetch(new URL('/rest/v1/rpc/' + name, cfg.supabaseUrl), {
      method: 'POST',
      headers: { apikey: cfg.supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit'
    });
    if (!response.ok) throw new Error('Trail request failed');
    return response.json();
  }

  function link(parts) {
    const url = new URL('trail.html', location.href);
    url.hash = new URLSearchParams(parts).toString();
    return url.href;
  }

  function show(id, focusHeading = false) {
    $(id).hidden = false;
    if (focusHeading) $(id).querySelector('h2').focus();
  }

  const timing = $('trailTiming');
  const opensInput = $('trailOpensAt');
  const expiresInput = $('trailExpiresAt');

  function syncTiming() {
    const custom = timing.value !== 'any';
    const startsLater = timing.value === 'window';
    $('trailTimingFields').hidden = !custom;
    $('trailOpeningLabel').hidden = !startsLater;
    opensInput.disabled = !startsLater;
    opensInput.required = startsLater;
    expiresInput.disabled = !custom;
    expiresInput.required = custom;
  }

  function readLocalTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    // Reject nonexistent local times during the spring clock change.
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    return local === value ? date.toISOString() : null;
  }

  function readWindow() {
    const opens_at = timing.value === 'window' ? readLocalTime(opensInput.value) : null;
    const expires_at = timing.value !== 'any' ? readLocalTime(expiresInput.value) : null;
    if (timing.value === 'any') return { opens_at, expires_at };
    if (!expires_at || (timing.value === 'window' && !opens_at)) {
      status('Choose a valid date and time in your device’s time zone.');
    } else if (Date.parse(expires_at) <= Date.now()) {
      status('Choose an expiration in the future.');
    } else if (opens_at && opens_at >= expires_at) {
      status('The opening time must be before the expiration.');
    } else {
      return { opens_at, expires_at };
    }
    return null;
  }

  function windowText({ opens_at, expires_at }) {
    if (!expires_at) return '';
    const end = timeFormat.format(new Date(expires_at));
    return opens_at ? 'Available from ' + timeFormat.format(new Date(opens_at)) + ' until ' + end + '.'
      : 'Available until ' + end + '.';
  }

  function showWindow(row) {
    if (row.status !== 'scheduled' && row.status !== 'expired') return false;
    const scheduled = row.status === 'scheduled';
    $('hunt').hidden = true;
    $('trailWindowHeading').textContent = scheduled ? 'This trail opens later' : 'This trail has closed';
    $('trailWindowMessage').textContent = scheduled ? windowText(row)
      : 'The clue link expired on ' + timeFormat.format(new Date(row.expires_at)) + '.';
    $('checkWindow').hidden = !scheduled;
    status('');
    show('trailWindow', true);
    return true;
  }

  $('trailTimeZone').textContent = 'Times use your device’s time zone (' + timeFormat.resolvedOptions().timeZone + ').';
  timing.addEventListener('change', syncTiming);
  syncTiming();

  function switchTab(saved) {
    for (const button of [$('composeTab'), $('savedTab')]) {
      const active = saved === (button.id === 'savedTab');
      button.classList.toggle('pri', active);
      button.setAttribute('aria-pressed', String(active));
    }
    if (saved) {
      form.hidden = true;
      $('links').hidden = true;
      status('');
      show('savedNotes');
      refreshSaved();
    } else {
      $('savedNotes').hidden = true;
      if (!composerStarted && ready) {
        composerStarted = true;
        startCompose();
      } else if (composerStarted) {
        show(composerStage);
        picker?.resize();
      } else {
        status('You’ve Got Trail needs an online BuffPrints connection.');
      }
    }
  }

  $('composeTab').addEventListener('click', () => switchTab(false));
  $('savedTab').addEventListener('click', () => switchTab(true));
  window.addEventListener('storage', event => {
    if ((!event.key || event.key.startsWith(library.prefix)) && !$('savedNotes').hidden) refreshSaved();
  });
  window.addEventListener('message', event => {
    if (!inApp || event.origin !== location.origin || event.source !== window.parent || event.data?.bp !== 'trail-refresh') return;
    if (!$('savedNotes').hidden) refreshSaved();
    else picker?.resize();
  });

  async function startCompose() {
    show('compose');
    try {
      picker = await window.TrailMap.initMap($('trailMap'), spot => {
        if (saving) return false;
        selectedStop = spot;
        $('create').disabled = false;
        $('spotStatus').textContent = 'Pin placed · ' + spot.name;
        return true;
      }, () => {
        if (saving) return;
        $('spotStatus').textContent = selectedStop
          ? 'Tap closer to a marked walkway. Your last pin is still selected.'
          : 'Tap closer to a marked walkway.';
      });
      $('spotStatus').textContent = 'Choose a spot on a marked walkway.';
      $('pinCenter').disabled = false;
    } catch {
      $('spotStatus').textContent = 'The campus map couldn’t load. Check your connection and reload.';
    }
  }

  $('pinCenter').addEventListener('click', () => picker.pickCenter());

  $('anotherNote').addEventListener('click', () => {
    $('links').hidden = true;
    composerStage = 'compose';
    $('inviteLink').value = '';
    $('deleteLink').value = '';
    selectedStop = null;
    $('create').disabled = true;
    $('spotStatus').textContent = 'Choose a spot on a marked walkway.';
    status('');
    show('compose', true);
    picker.reset();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || $('create').disabled) return;

    const data = new FormData(form);
    const stop = selectedStop;
    const sender = data.get('sender').trim();
    const note = data.get('note').trim();
    if (!stop || !sender || !note) {
      status('Choose a stop and fill in your sign-off and note.');
      return;
    }
    const clue = data.get('clue').trim() || (stop.name === 'Campus walkway'
      ? 'Find the marked spot on a campus walkway. Show the outdoor spot for the pin.'
      : 'Find the marked spot along ' + stop.name + '.');
    const windowData = readWindow();
    if (!windowData) return;
    const payload = JSON.stringify({ sender, note, stop, clue, windowData });
    const button = $('create');
    saving = true;
    button.disabled = true;
    $('pinCenter').disabled = true;
    status('Hiding your note…');
    try {
      if (pendingSave?.payload !== payload) {
        const inviteKey = core.newHerdKey();
        const keys = await core.deriveKeys(inviteKey);
        const [sealedNote, sealedClue] = await Promise.all([
          core.seal(keys, { sender, note }),
          core.seal(keys, { clue, stop })
        ]);
        pendingSave = {
          payload, id: crypto.randomUUID(), deletion: crypto.randomUUID(), key: inviteKey,
          sealedNote, sealedClue
        };
      }
      const saved = pendingSave;
      const args = {
        trail_id: saved.id, delete_key: saved.deletion, sealed: saved.sealedNote,
        clue: saved.sealedClue, lat: stop.lat, lng: stop.lng
      };
      const result = windowData.expires_at
        ? await rpc('trail_create_timed', { ...args, ...windowData })
        : await rpc('trail_create', args);
      if (result === 'invalid_window') {
        status('The expiration must be in the future and within 365 days of hiding the note.');
        return;
      }
      if (result === 'busy') {
        status('BuffPrints is busy. Wait a moment and try again.');
        return;
      }
      if (result !== 'ok') throw new Error('Trail could not be created');

      $('inviteLink').value = link({ trail: saved.id, key: saved.key });
      $('deleteLink').value = link({ trail: saved.id, delete: saved.deletion });
      pendingSave = null;
      $('linkTiming').textContent = windowText(windowData) || 'The clue link works for 365 days.';
      form.reset();
      syncTiming();
      form.hidden = true;
      composerStage = 'links';
      if ($('savedNotes').hidden) {
        status('');
        show('links', true);
      }
    } catch {
      status('Your link couldn’t be saved. Check your connection and try again.');
    } finally {
      saving = false;
      button.disabled = false;
      $('pinCenter').disabled = false;
    }
  });

  $('links').addEventListener('click', async event => {
    const field = event.target.dataset.copy;
    if (!field) return;
    const input = $(field);
    try {
      await navigator.clipboard.writeText(input.value);
      status(field === 'inviteLink' ? 'Clue link copied.' : 'Deletion link copied.');
    } catch {
      input.focus();
      input.select();
      status('Select and copy the link from the box.');
    }
  });

  async function loadTrail() {
    $('retry').hidden = true;
    $('trailWindow').hidden = true;
    status('Looking up your clue…');
    let row;
    try {
      row = await rpc('trail_get', { trail_id: id });
    } catch {
      status('The clue couldn’t load. Check your connection and try again.');
      $('retry').hidden = false;
      return;
    }
    if (row?.status === 'legacy') {
      status('This clue was created before location check-ins were required. Ask the sender for a new clue link.');
      return;
    }
    if (row && showWindow(row)) return;
    if (row?.clue) {
      try {
        const { clue, stop } = await core.open(await core.deriveKeys(key), row.clue);
        hiddenAt = row.created_at;
        $('hiddenDate').textContent = 'Hidden on ' + dateFormat.format(new Date(hiddenAt));
        $('huntTiming').textContent = windowText(row);
        $('huntTiming').hidden = !row.expires_at;
        $('clueText').textContent = clue;
        $('stopText').textContent = stop.name;
        $('stopMapLink').href = 'https://www.google.com/maps/search/?api=1&query='
          + encodeURIComponent(stop.lat + ',' + stop.lng);
        status('');
        show('hunt', true);
        return;
      } catch {
        // A mistyped key and a missing note show the same message.
      }
    }
    status(unavailable);
  }

  function reveal({ note, sender }) {
    $('hunt').hidden = true;
    revealedNote = { trail_id: id, note, sender, hidden_at: hiddenAt };
    $('foundDate').textContent = 'Hidden on ' + dateFormat.format(new Date(hiddenAt));
    $('noteText').textContent = note;
    $('signoff').textContent = 'From ' + sender;
    status('');
    show('reveal', true);
  }

  $('keepNote').addEventListener('click', () => {
    if (!revealedNote) return;
    try {
      library.keep(revealedNote);
      $('keepNote').disabled = true;
      $('keepNote').textContent = 'Saved on this device';
      $('openSaved').hidden = false;
      status('Your copy is saved without an expiration date.');
    } catch {
      status('This browser couldn’t save the note on this device.');
    }
  });

  const checkIn = $('checkIn');
  checkIn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      status('Location is unavailable on this device. Try opening the clue on a phone with GPS.');
      return;
    }
    checkIn.disabled = true;
    status('Checking your location…');
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        const result = await rpc('trail_unlock', {
          trail_id: id, lat: coords.latitude, lng: coords.longitude, accuracy_m: coords.accuracy
        });
        if (result.status === 'ok') {
          reveal(await core.open(await core.deriveKeys(key), result.sealed));
        } else if (showWindow(result)) {
          return;
        } else if (result.status === 'outside') {
          status('You’re outside the check-in area. Get closer to the pin and try again.');
        } else if (result.status === 'inaccurate') {
          status('Your phone’s location is too fuzzy. Check that precise location is enabled and try again.');
        } else {
          status(unavailable);
        }
      } catch {
        status('The check-in couldn’t finish. Check your connection and try again.');
      } finally {
        checkIn.disabled = false;
      }
    }, error => {
      checkIn.disabled = false;
      status(error.code === 1
        ? 'Allow location in your browser to check in at the hiding spot.'
        : 'Your phone couldn’t get a location. Try again from the outdoor spot.');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  });

  $('retry').addEventListener('click', loadTrail);
  $('checkWindow').addEventListener('click', loadTrail);
  $('remove').addEventListener('click', async () => {
    if (!window.confirm('Delete the note and disable its clue link?')) return;
    $('remove').disabled = true;
    try {
      const removed = await rpc('trail_remove', { trail_id: id, delete_key: deletion });
      $('manage').hidden = true;
      status(removed ? 'The note was deleted.' : 'This deletion link is invalid or the note is already gone.');
    } catch {
      status('The note couldn’t be deleted. Check your connection and try again.');
    } finally {
      $('remove').disabled = false;
    }
  });

  if (inApp) $('trailHome').hidden = true;

  if (!location.hash) {
    $('trailNav').hidden = false;
    switchTab(params.has('saved'));
  } else if (!ready) status('You’ve Got Trail needs an online BuffPrints connection.');
  else if (uuid.test(id) && uuid.test(deletion) && !key) show('manage');
  else if (uuid.test(id) && core.validKey(key) && !deletion) loadTrail();
  else status(unavailable);
})();
