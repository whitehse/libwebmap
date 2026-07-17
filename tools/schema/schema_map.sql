-- Map feature tables (data only — no display policy).
-- Rows are mappable geometry + attributes. Style/tessellation lives in the host
-- (demo/display/) or an optional bake step.
--
-- Populated by fiber2features from fiber_design.sqlite (or written as
-- OUT/features.sqlite alongside .fmap tiles).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS map_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Cable / drop spans for the map (WGS84 line coordinates stored as WKB).
CREATE TABLE IF NOT EXISTS map_cables (
  id            INTEGER PRIMARY KEY,
  guid          TEXT,
  is_drop       INTEGER NOT NULL DEFAULT 0,
  cable_size    INTEGER,
  strand_color  TEXT,          -- TIA name (data attribute)
  tube_color    TEXT,
  rgba          INTEGER,       -- packed 0xAABBGGRR convenience color
  geom_wgs84    BLOB           -- WKB LineString (lon/lat), optional
);

CREATE INDEX IF NOT EXISTS map_cables_drop_idx ON map_cables(is_drop);

-- Tap nodes: one row per tap equipment feature.
CREATE TABLE IF NOT EXISTS map_taps (
  id            INTEGER PRIMARY KEY,
  equip_guid    TEXT,
  sp_guid       TEXT,          -- splicepoint GUID (for diagram link)
  lon           REAL NOT NULL,
  lat           REAL NOT NULL,
  ports         INTEGER NOT NULL,  -- drop port count (first-class column)
  strand_color  TEXT,
  tube_color    TEXT,
  strand_rgba   INTEGER,
  tube_rgba     INTEGER,
  diagram       TEXT           -- HTML basename under splice_diagrams/
);

CREATE INDEX IF NOT EXISTS map_taps_lonlat ON map_taps(lon, lat);

-- Non-tap splicepoints (no tap equipment at the SP).
CREATE TABLE IF NOT EXISTS map_splices (
  id            INTEGER PRIMARY KEY,
  sp_guid       TEXT,
  lon           REAL NOT NULL,
  lat           REAL NOT NULL,
  station_id    TEXT,
  rgba          INTEGER,
  diagram       TEXT           -- HTML basename under splice_diagrams/
);

CREATE INDEX IF NOT EXISTS map_splices_lonlat ON map_splices(lon, lat);
