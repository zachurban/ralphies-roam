const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function psql(database, ...args) {
  return spawnSync('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', database, ...args], { encoding: 'utf8' });
}

const reachable = psql('postgres', '-c', 'select 1').status === 0;

test('trail RPCs keep encrypted notes private, revocable and time-limited', {
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

  sql('postgres', '-c', 'create database ' + database);
  try {
    sql(database, '-f', path.join(__dirname, 'supabase-shim.sql'));
    sql(database, '-f', path.join(__dirname, '../supabase/migrations/20261118160000_youve_got_trail.sql'));

    assert.equal(anon(`select trail_create(${id}, ${key}, 'plaintext')`), 'invalid');
    assert.equal(anon(`select trail_create(${id}, ${key}, '${sealed}')`), 'ok');
    assert.equal(anon(`select trail_create(${id}, ${key}, '${sealed}')`), 'ok');
    assert.equal(anon(`select trail_create(${id}, ${otherKey}, '${sealed}')`), 'invalid');
    assert.equal(anon(`select trail_remove(${id}, ${otherKey})`), 'f');

    const result = JSON.parse(anon(`select trail_get(${id})`));
    assert.equal(result.sealed, sealed);
    assert.ok(Date.parse(result.created_at));
    assert.deepEqual(Object.keys(result).sort(), ['created_at', 'sealed']);
    assert.notEqual(psql(database, '-c', 'set role anon; select * from public.trail_notes').status, 0);
    assert.equal(anon(`select trail_remove(${id}, ${key})`), 't');
    assert.equal(anon(`select trail_get(${id}) is null`), 't');

    assert.equal(anon(`select trail_create(${id}, ${key}, '${sealed}')`), 'ok');
    owner("update public.trail_notes set created_at = now() - interval '366 days'");
    assert.equal(anon(`select trail_get(${id}) is null`), 't');
    assert.equal(anon(`select trail_create(${id}, ${key}, '${sealed}')`), 'ok');
    assert.equal(owner('select count(*) from public.trail_notes'), '1');

    owner(`insert into public.trail_notes (id, delete_hash, sealed)
      select gen_random_uuid(), sha256('test'::bytea), '${sealed}' from generate_series(1, 29)`);
    assert.equal(anon(`select trail_create(gen_random_uuid(), ${key}, '${sealed}')`), 'busy');
    assert.equal(anon(`select trail_create(${id}, ${key}, '${sealed}')`), 'ok');
  } finally {
    sql('postgres', '-c', 'drop database ' + database);
  }
});
