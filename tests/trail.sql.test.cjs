const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function psql(database, ...args) {
  return spawnSync('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', database, ...args], { encoding: 'utf8' });
}

const reachable = psql('postgres', '-c', 'select 1').status === 0;

test('trail notes require a location check and stay private, revocable and time-limited', {
  skip: reachable ? false : 'no PostgreSQL server reachable'
}, () => {
  const database = 'rr_trail_' + process.pid;
  function sql(databaseName, ...args) {
    const result = psql(databaseName, ...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  const owner = query => sql(database, '-c', query);
  const anon = query => owner('set role anon; ' + query);
  const id = "'86aa2991-2351-42f8-b52b-662631de54ac'";
  const key = "'c0c6da9b-321a-4daa-aef7-a7c5154955a0'";
  const otherKey = "'d75bd5eb-20d4-43fa-93fa-fc33a090d556'";
  const sealed = 'v1.' + 'A'.repeat(16) + '.' + 'Z'.repeat(24);
  const clue = 'v1.' + 'B'.repeat(16) + '.' + 'Y'.repeat(24);
  const legacy = "'53a21297-938b-41f6-9cd8-117026ef238c'";
  const create = (which = id, deletion = key, note = sealed, lat = 40.0088) =>
    anon(`select trail_create(${which}, ${deletion}, '${note}', '${clue}', ${lat}, -105.27112)`);
  const get = which => JSON.parse(anon(`select trail_get(${which})`) || 'null');
  const unlock = (lat = 40.0088, accuracy = 15, which = id) =>
    JSON.parse(anon(`select trail_unlock(${which}, ${lat}, -105.27112, ${accuracy})`));

  sql('postgres', '-c', 'create database ' + database);
  try {
    sql(database, '-f', path.join(__dirname, 'supabase-shim.sql'));
    sql(database, '-f', path.join(__dirname, '../supabase/migrations/20261118160000_youve_got_trail.sql'));

    assert.equal(anon(`select trail_create(${legacy}, ${key}, '${sealed}')`), 'ok');
    sql(database, '-f', path.join(__dirname, '../supabase/migrations/20261118170000_trail_location_gate.sql'));

    assert.deepEqual(get(legacy), { status: 'legacy' });
    assert.deepEqual(unlock(40.0088, 15, legacy), { status: 'unavailable' });
    assert.equal(anon(`select trail_remove(${legacy}, ${key})`), 't');
    assert.equal(create(id, key, 'plaintext'), 'invalid');
    assert.equal(create(id, key, sealed, 41), 'invalid');
    assert.equal(create(), 'ok');
    assert.equal(create(), 'ok');
    assert.equal(create(id, otherKey), 'invalid');
    assert.equal(create(id, key, sealed, 40.0089), 'invalid');
    assert.equal(anon(`select trail_remove(${id}, ${otherKey})`), 'f');

    const result = get(id);
    assert.equal(result.clue, clue);
    assert.ok(Date.parse(result.created_at));
    assert.deepEqual(Object.keys(result).sort(), ['clue', 'created_at']);
    assert.deepEqual(unlock(40.00917), { status: 'outside' });
    assert.deepEqual(unlock(40.00915, 35), { status: 'ok', sealed });
    assert.deepEqual(unlock(40.0088, 36), { status: 'inaccurate' });
    assert.deepEqual(unlock("'NaN'"), { status: 'inaccurate' });
    assert.deepEqual(unlock('null'), { status: 'inaccurate' });
    assert.notEqual(psql(database, '-c', 'set role anon; select * from public.trail_notes').status, 0);
    assert.equal(anon(`select trail_remove(${id}, ${key})`), 't');
    assert.equal(get(id), null);
    assert.deepEqual(unlock(), { status: 'unavailable' });

    assert.equal(create(), 'ok');
    owner("update public.trail_notes set created_at = now() - interval '366 days'");
    assert.equal(get(id), null);
    assert.deepEqual(unlock(), { status: 'unavailable' });
    assert.equal(create(), 'ok');
    assert.equal(owner('select count(*) from public.trail_notes'), '1');

    owner(`insert into public.trail_notes (id, delete_hash, sealed)
      select gen_random_uuid(), sha256('test'::bytea), '${sealed}' from generate_series(1, 29)`);
    assert.equal(create('gen_random_uuid()'), 'busy');
    assert.equal(create(), 'ok');
  } finally {
    sql('postgres', '-c', 'drop database ' + database);
  }
});
