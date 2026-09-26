/** Durable conversation state. The complete approved recap is part of `state`. */

export class RevisionConflictError extends Error {
  constructor(chatId, expectedRevision) {
    super(`Conversation ${chatId} changed since revision ${expectedRevision}. Reload and retry.`);
    this.name = 'RevisionConflictError';
    this.chatId = String(chatId);
    this.expectedRevision = expectedRevision;
  }
}

function key(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new TypeError(`${label} is required`);
  }
  return String(value);
}

function revisionNumber(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RangeError('Revision must be a nonnegative safe integer');
  }
  return revision;
}

function stateJson(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('State must be a JSON object');
  }
  const json = JSON.stringify(state);
  if (!json) throw new TypeError('State must be serializable as JSON');
  return json;
}

function cloneState(state) {
  return JSON.parse(stateJson(state));
}

/**
 * Local deterministic store for tests. It is never selected by createStore().
 * API: load(id) -> {state, revision}; save(id, state, expectedRevision) -> revision.
 */
export class MemoryStore {
  #conversations = new Map();
  #updates = new Map();

  async load(chatId) {
    const found = this.#conversations.get(key(chatId, 'chatId'));
    return found
      ? { state: cloneState(found.state), revision: found.revision }
      : { state: null, revision: 0 };
  }

  async save(chatId, state, expectedRevision) {
    const id = key(chatId, 'chatId');
    const expected = revisionNumber(expectedRevision);
    const current = this.#conversations.get(id);
    if ((current?.revision ?? 0) !== expected) {
      throw new RevisionConflictError(id, expected);
    }
    const revision = expected + 1;
    this.#conversations.set(id, { state: cloneState(state), revision });
    return revision;
  }

  async claimUpdate(updateId) {
    const id = key(updateId, 'updateId');
    if (this.#updates.has(id)) return false;
    this.#updates.set(id, 'pending');
    return true;
  }

  async completeUpdate(updateId) {
    const id = key(updateId, 'updateId');
    if (this.#updates.get(id) !== 'pending') return false;
    this.#updates.set(id, 'completed');
    return true;
  }

  async releaseUpdate(updateId) {
    const id = key(updateId, 'updateId');
    if (this.#updates.get(id) !== 'pending') return false;
    this.#updates.delete(id);
    return true;
  }

  async close() {}
}

export class PostgresStore {
  #databaseUrl;
  #pool;
  #ownsPool;
  #ready;

  constructor({ databaseUrl, pool } = {}) {
    if (!pool && !databaseUrl) {
      throw new Error('DATABASE_URL is required for durable Telegram alignment storage');
    }
    this.#databaseUrl = databaseUrl;
    this.#pool = pool ?? null;
    this.#ownsPool = !pool;
  }

  async #initialize() {
    if (!this.#ready) {
      this.#ready = (async () => {
        if (!this.#pool) {
          const { Pool } = await import('pg');
          this.#pool = new Pool({ connectionString: this.#databaseUrl });
        }
        await this.#pool.query(`
          CREATE TABLE IF NOT EXISTS telegram_alignment_conversations (
            chat_id TEXT PRIMARY KEY,
            revision BIGINT NOT NULL CHECK (revision > 0),
            state JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await this.#pool.query(`
          CREATE TABLE IF NOT EXISTS telegram_alignment_updates (
            update_id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
            leased_until TIMESTAMPTZ,
            claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
          )
        `);
      })().catch(error => {
        this.#ready = null;
        throw error;
      });
    }
    await this.#ready;
  }

  async load(chatId) {
    await this.#initialize();
    const id = key(chatId, 'chatId');
    const { rows } = await this.#pool.query(
      'SELECT state, revision FROM telegram_alignment_conversations WHERE chat_id = $1',
      [id],
    );
    return rows.length
      ? { state: rows[0].state, revision: revisionNumber(rows[0].revision) }
      : { state: null, revision: 0 };
  }

  async save(chatId, state, expectedRevision) {
    await this.#initialize();
    const id = key(chatId, 'chatId');
    const expected = revisionNumber(expectedRevision);
    const json = stateJson(state);
    const result = expected === 0
      ? await this.#pool.query(`
          INSERT INTO telegram_alignment_conversations (chat_id, revision, state)
          VALUES ($1, 1, $2::jsonb)
          ON CONFLICT (chat_id) DO NOTHING
          RETURNING revision
        `, [id, json])
      : await this.#pool.query(`
          UPDATE telegram_alignment_conversations
          SET revision = revision + 1, state = $2::jsonb, updated_at = NOW()
          WHERE chat_id = $1 AND revision = $3
          RETURNING revision
        `, [id, json, expected]);
    if (!result.rows.length) throw new RevisionConflictError(id, expected);
    return revisionNumber(result.rows[0].revision);
  }

  /** Claim a Telegram update. A crashed pending claim can be retried after 10 minutes. */
  async claimUpdate(updateId) {
    await this.#initialize();
    const { rows } = await this.#pool.query(`
      INSERT INTO telegram_alignment_updates (update_id, status, leased_until)
      VALUES ($1, 'pending', NOW() + INTERVAL '10 minutes')
      ON CONFLICT (update_id) DO UPDATE
      SET leased_until = EXCLUDED.leased_until, claimed_at = NOW()
      WHERE telegram_alignment_updates.status = 'pending'
        AND telegram_alignment_updates.leased_until < NOW()
      RETURNING update_id
    `, [key(updateId, 'updateId')]);
    return rows.length > 0;
  }

  /** Call only after processing and the state save have succeeded. */
  async completeUpdate(updateId) {
    await this.#initialize();
    const { rows } = await this.#pool.query(`
      UPDATE telegram_alignment_updates
      SET status = 'completed', leased_until = NULL, completed_at = NOW()
      WHERE update_id = $1 AND status = 'pending'
      RETURNING update_id
    `, [key(updateId, 'updateId')]);
    return rows.length > 0;
  }

  /** Release a pending claim if the handler failed, so the update can be retried. */
  async releaseUpdate(updateId) {
    await this.#initialize();
    const { rows } = await this.#pool.query(`
      DELETE FROM telegram_alignment_updates
      WHERE update_id = $1 AND status = 'pending'
      RETURNING update_id
    `, [key(updateId, 'updateId')]);
    return rows.length > 0;
  }

  async close() {
    if (this.#ownsPool && this.#pool) await this.#pool.end();
  }
}

/** Production entry point: deliberately never falls back to volatile memory. */
export function createStore({ databaseUrl = process.env.DATABASE_URL, pool } = {}) {
  return new PostgresStore({ databaseUrl, pool });
}
