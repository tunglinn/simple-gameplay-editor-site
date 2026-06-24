CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event     TEXT    NOT NULL,
  message   TEXT,
  browser   TEXT,
  url       TEXT,
  ts        TEXT    NOT NULL DEFAULT (datetime('now'))
);
