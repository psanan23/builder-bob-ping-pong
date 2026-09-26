import assert from 'node:assert/strict';
import test from 'node:test';

import { createStore, MemoryStore, RevisionConflictError } from './store.mjs';

test('deployed store requires a durable database URL', () => {
  assert.throws(
    () => createStore({ databaseUrl: '' }),
    /DATABASE_URL is required/,
  );
});

test('a chat starts empty, and stale writes cannot overwrite a newer revision', async () => {
  const store = new MemoryStore();
  assert.deepEqual(await store.load(42), { state: null, revision: 0 });

  assert.equal(await store.save(42, { phase: 'questions' }, 0), 1);
  assert.equal(await store.save(42, { phase: 'recap' }, 1), 2);
  await assert.rejects(
    store.save(42, { phase: 'old answer' }, 1),
    RevisionConflictError,
  );
  assert.deepEqual(await store.load(42), {
    state: { phase: 'recap' }, revision: 2,
  });
});

test('different testers and returned copies cannot change one another', async () => {
  const store = new MemoryStore();
  await store.save('bon', { project: { name: 'Balcony' } }, 0);
  await store.save('other', { project: { name: 'Garden' } }, 0);

  const bon = await store.load('bon');
  bon.state.project.name = 'Changed outside storage';
  assert.equal((await store.load('bon')).state.project.name, 'Balcony');
  assert.equal((await store.load('other')).state.project.name, 'Garden');
});

test('approved snapshot remains exact and available after later revisions', async () => {
  const store = new MemoryStore();
  const approvedRecap = {
    version: 2,
    completionState: 'A usable balcony reading corner',
    firstTwoWeeks: 'Check the space and reuse the chair',
  };
  const approval = {
    recap: approvedRecap,
    approvedBy: 'bon',
    approvedAt: '2026-09-26T06:00:00.000Z',
  };

  await store.save('bon', {
    recap: approvedRecap,
    recapHistory: [{ version: 1 }, approvedRecap],
    approvedDirection: approval,
  }, 0);
  await store.save('bon', {
    recap: { version: 3, completionState: 'A changed proposal' },
    recapHistory: [{ version: 1 }, approvedRecap, { version: 3 }],
    approvedDirection: approval,
  }, 1);

  const reloaded = await store.load('bon');
  assert.equal(reloaded.revision, 2);
  assert.deepEqual(reloaded.state.approvedDirection, approval);
  assert.equal(reloaded.state.recap.version, 3);
});

test('Telegram update claims can be retried after failure but not after completion', async () => {
  const store = new MemoryStore();
  assert.equal(await store.claimUpdate(100), true);
  assert.equal(await store.claimUpdate(100), false);
  assert.equal(await store.releaseUpdate(100), true);
  assert.equal(await store.claimUpdate(100), true);
  assert.equal(await store.completeUpdate(100), true);
  assert.equal(await store.claimUpdate(100), false);
  assert.equal(await store.releaseUpdate(100), false);
});
