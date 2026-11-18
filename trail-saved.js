/* Personal copies are independent of the shared clue link. */
(() => {
  'use strict';

  const prefix = 'rr-trail-saved:';

  function readDevice() {
    try {
      return Object.keys(localStorage).filter(key => key.startsWith(prefix)).flatMap(key => {
        try {
          const entry = JSON.parse(localStorage.getItem(key));
          return entry && key === prefix + entry.trail_id && typeof entry.note === 'string'
            && typeof entry.sender === 'string' && Number.isFinite(Date.parse(entry.hidden_at)) ? [entry] : [];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  function keep(entry) {
    localStorage.setItem(prefix + entry.trail_id, JSON.stringify({ ...entry, saved_at: new Date().toISOString() }));
  }

  function mount({ getClient, signIn, dateFormat }) {
    const $ = id => document.getElementById(id);
    const list = $('savedList');
    const status = $('savedStatus');
    const signInButton = $('savedSignIn');
    let revision = 0;

    function element(tag, text, className) {
      const item = document.createElement(tag);
      item.textContent = text;
      if (className) item.className = className;
      return item;
    }

    function button(label, callback) {
      const item = element('button', label, 'btn');
      item.type = 'button';
      item.addEventListener('click', async () => {
        item.disabled = true;
        try {
          const message = await callback();
          await refresh(message);
        } catch {
          status.textContent = 'Couldn’t update the saved note. Try again.';
        } finally {
          item.disabled = false;
        }
      });
      return item;
    }

    async function refresh(message = '') {
      const version = ++revision;
      const device = new Map(readDevice().map(entry => [entry.trail_id, entry]));
      const client = navigator.onLine ? getClient() : null;
      let user;
      let synced = [];
      list.replaceChildren();
      signInButton.hidden = true;
      status.textContent = client ? 'Loading saved notes…' : '';
      if (client) {
        try {
          const { data, error } = await client.auth.getSession();
          if (error) throw error;
          user = data.session?.user;
          if (user) {
            const result = await client.from('trail_saved_notes')
              .select('trail_id,note,sender,hidden_at,saved_at').eq('user_id', user.id).order('saved_at', { ascending: false });
            if (result.error) throw result.error;
            synced = result.data;
          }
        } catch {
          message = 'Couldn’t load notes from your account. Try again from the Saved notes tab.';
        }
      }
      if (version !== revision) return;
      signInButton.hidden = !client || !!user;
      const account = new Map(synced.map(entry => [entry.trail_id, entry]));
      const entries = new Map([...device, ...account]);
      status.textContent = message || (entries.size ? '' : 'Notes you keep after a check-in will appear here.');

      for (const entry of [...entries.values()].sort((a, b) => Date.parse(b.saved_at) - Date.parse(a.saved_at))) {
        const entryId = entry.trail_id;
        const onDevice = device.has(entryId);
        const inAccount = account.has(entryId);
        const location = onDevice && inAccount ? 'On this device and in your account'
          : inAccount ? 'In your account' : 'On this device';
        const card = element('details', '', 'trail-clue trail-saved-note');
        const actions = element('div', '', 'btns');
        card.append(
          element('summary', 'From ' + entry.sender + ' · ' + dateFormat.format(new Date(entry.hidden_at))),
          element('p', location, 'trail-muted'),
          element('p', entry.note, 'trail-message'),
          actions
        );

        if (onDevice && user && !inAccount) {
          actions.append(button('Save to my account', async () => {
            const copy = device.get(entryId);
            const { error } = await client.from('trail_saved_notes').upsert({
              user_id: user.id, trail_id: entryId, note: copy.note, sender: copy.sender, hidden_at: copy.hidden_at
            }, { onConflict: 'user_id,trail_id', ignoreDuplicates: true });
            if (error) throw error;
            return 'Saved to your account.';
          }));
        }
        if (onDevice) {
          actions.append(button('Remove from this device', () => {
            localStorage.removeItem(prefix + entryId);
            return 'Removed from this device.';
          }));
        }
        if (inAccount) {
          actions.append(button('Remove from my account', async () => {
            const { error } = await client.from('trail_saved_notes').delete().eq('user_id', user.id).eq('trail_id', entryId);
            if (error) throw error;
            return 'Removed from your account.';
          }));
        }
        list.append(card);
      }
    }

    signInButton.addEventListener('click', signIn);
    return refresh;
  }

  window.TrailSaved = { prefix, readDevice, keep, mount };
})();
