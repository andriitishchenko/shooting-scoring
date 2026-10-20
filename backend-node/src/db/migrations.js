// Each item changes the schema from version N to N + 1.
// The project creates each database again, so the schema is one item. Change it in place.
// When databases must stay, add a new item at the end and do not change an old item. The server runs the missing items when it opens a database.
export const migrations = [
  `
  CREATE TABLE event (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    code        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'started', 'finished')),
    shots_count INTEGER NOT NULL CHECK (shots_count BETWEEN 1 AND 300),
    allow_lane_add INTEGER NOT NULL DEFAULT 1 CHECK (allow_lane_add IN (0, 1)),
    lane_count  INTEGER NOT NULL DEFAULT 28 CHECK (lane_count BETWEEN 1 AND 999),
    created_at  TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT
  );
  CREATE TABLE credentials (
    role TEXT PRIMARY KEY CHECK (role IN ('host', 'viewer')),
    hash TEXT NOT NULL
  );
  -- The host can read the lane passwords. The server keeps the password of a
  -- lane in the clear, in addition to the hash that it uses to check logins.
  CREATE TABLE lanes (
    lane          INTEGER PRIMARY KEY CHECK (lane BETWEEN 1 AND 999),
    password_hash TEXT NOT NULL,
    password      TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    role       TEXT NOT NULL CHECK (role IN ('host', 'viewer', 'lane')),
    lane       INTEGER REFERENCES lanes (lane) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX sessions_role ON sessions (role, lane, created_at);
  CREATE TABLE distances (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    shots_count INTEGER NOT NULL CHECK (shots_count BETWEEN 1 AND 300),
    sort_order  INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'finished'))
  );
  CREATE TABLE participants (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    lane            INTEGER NOT NULL CHECK (lane BETWEEN 1 AND 999),
    shift           TEXT NOT NULL,
    gender          TEXT,
    age_category    TEXT,
    shooting_type   TEXT,
    group_type      TEXT,
    personal_number TEXT
  );
  CREATE INDEX participants_lane ON participants (lane, shift);
  CREATE TABLE results (
    participant_id INTEGER NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
    distance_id    INTEGER NOT NULL REFERENCES distances (id) ON DELETE CASCADE,
    shot           INTEGER NOT NULL CHECK (shot BETWEEN 1 AND 300),
    score          INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10),
    is_x           INTEGER NOT NULL DEFAULT 0 CHECK (is_x IN (0, 1) AND (is_x = 0 OR score = 10)),
    PRIMARY KEY (participant_id, distance_id, shot)
  ) WITHOUT ROWID;
  CREATE INDEX results_distance ON results (distance_id);
  `,
];

export function migrate(connection) {
  const current = connection.prepare("PRAGMA user_version").get().user_version;
  if (current > migrations.length)
    throw new Error(`The database is from a newer version of the server (schema ${current})`);
  for (let version = current; version < migrations.length; version++) {
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection.exec(migrations[version]);
      connection.exec(`PRAGMA user_version = ${version + 1}`);
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  }
}
