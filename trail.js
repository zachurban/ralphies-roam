/* You've Got Trail. GPS check-ins and readable notes stay on the phone. */
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

  // Use the outdoor stops already in the bundled Roam. Their pins need an on-campus check.
  const outdoorClues = new Map([
    ['norlin-quad', 'Head to the quad outside the library named for George Norlin.'],
    ['macky-south', 'Find the south plaza outside Macky Auditorium.']
  ]);
  const stops = new Map(window.HERD_EDITIONS.editions[0].content.checkpoints
    .filter(stop => outdoorClues.has(stop.id))
    .map(stop => [stop.id, stop]));

  const fragment = new URLSearchParams(location.hash.slice(1));
  const id = fragment.get('trail') || '';
  const key = fragment.get('key') || '';
  const deletion = fragment.get('delete') || '';
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  let pendingSave;
  let trail;
  let createdAt;

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

  function startCompose() {
    const select = form.elements.stop;
    for (const stop of stops.values()) {
      select.add(new Option(stop.name + ' · ' + stop.spot, stop.id));
    }
    const showClue = () => { $('suggestion').textContent = outdoorClues.get(select.value); };
    select.addEventListener('change', showClue);
    showClue();
    show('compose');
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if ($('create').disabled) return;

    const data = new FormData(form);
    const stop = stops.get(data.get('stop'));
    const sender = data.get('sender').trim();
    const note = data.get('note').trim();
    if (!stop || !sender || !note) {
      status('Choose a stop and fill in your sign-off and note.');
      return;
    }
    // Keep the selected coordinates in the encrypted note so older links survive pin updates.
    const { name, spot, lat, lng, radius_m } = stop;
    const payload = JSON.stringify({
      sender, note, stop: { name, spot, lat, lng, radius_m },
      clue: data.get('clue').trim() || outdoorClues.get(stop.id)
    });

    const button = $('create');
    button.disabled = true;
    status('Hiding your note…');
    try {
      if (pendingSave?.payload !== payload) {
        const inviteKey = core.newHerdKey();
        pendingSave = {
          payload, id: crypto.randomUUID(), deletion: crypto.randomUUID(), key: inviteKey,
          ciphertext: await core.seal(await core.deriveKeys(inviteKey), JSON.parse(payload))
        };
      }
      const saved = pendingSave;
      const result = await rpc('trail_create', {
        trail_id: saved.id, delete_key: saved.deletion, sealed: saved.ciphertext
      });
      if (result === 'busy') {
        status('BuffPrints is busy. Wait a moment and try again.');
        return;
      }
      if (result !== 'ok') throw new Error('Trail could not be created');

      $('inviteLink').value = link({ trail: saved.id, key: saved.key });
      $('deleteLink').value = link({ trail: saved.id, delete: saved.deletion });
      pendingSave = null;
      form.reset();
      form.hidden = true;
      status('');
      show('links', true);
    } catch {
      status('Your link couldn’t be saved. Check your connection and try again.');
    } finally {
      button.disabled = false;
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
    status('Looking up your clue…');
    let row;
    try {
      row = await rpc('trail_get', { trail_id: id });
    } catch {
      status('The clue couldn’t load. Check your connection and try again.');
      $('retry').hidden = false;
      return;
    }
    if (row) {
      try {
        trail = await core.open(await core.deriveKeys(key), row.sealed);
        createdAt = 'Hidden on ' + dateFormat.format(new Date(row.created_at));
        $('hiddenDate').textContent = createdAt;
        $('clueText').textContent = trail.clue;
        $('stopText').textContent = trail.stop.name + ' · ' + trail.stop.spot;
        status('');
        show('hunt', true);
        return;
      } catch {
        // A mistyped key and a missing note show the same message.
      }
    }
    status(unavailable);
  }

  function reveal() {
    $('hunt').hidden = true;
    $('foundDate').textContent = createdAt;
    $('noteText').textContent = trail.note;
    $('signoff').textContent = 'From ' + trail.sender;
    status('');
    show('reveal', true);
  }

  $('checkIn').addEventListener('click', () => {
    const button = $('checkIn');
    if (!navigator.geolocation) {
      status('Location is unavailable on this phone. You can still open the note.');
      return;
    }
    button.disabled = true;
    status('Checking your location…');
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      button.disabled = false;
      if ($('hunt').hidden) return;
      const fence = core.geofence({
        lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy
      }, trail.stop);
      if (fence.inside) reveal();
      else status(fence.state === 'outside'
        ? 'You’re outside the check-in area. See the outdoor spot above or use “Open now”.'
        : 'Your phone’s location is a little fuzzy. Try again or use “Open now”.');
    }, () => {
      button.disabled = false;
      if (!$('hunt').hidden) status('Your location couldn’t be checked. Try again or use “Open now”.');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  });

  $('openNow').addEventListener('click', reveal);
  $('retry').addEventListener('click', loadTrail);
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

  if (!ready) status('You’ve Got Trail needs an online BuffPrints connection.');
  else if (!location.hash) startCompose();
  else if (uuid.test(id) && uuid.test(deletion) && !key) show('manage');
  else if (uuid.test(id) && core.validKey(key) && !deletion) loadTrail();
  else status(unavailable);
})();
