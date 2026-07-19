/**
 * @file webmap.h
 * @brief WebGPU-oriented web map engine — pure C, WASM-friendly plumbing.
 *
 * Holds basemap geometry (pre-tessellated .wmap tiles) and dynamic overlay
 * features (fiber / electric status). The host owns WebGPU device creation
 * and buffer upload; this library owns data, projection, viewport, and
 * GPU-ready buffer descriptors (ADR-007, ADR-008).
 *
 * Syscall-free in the core (ADR-004). No Emscripten (ADR-009).
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef LIBWEBMAP_H
#define LIBWEBMAP_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Configuration ─────────────────────────────────────────────────── */

typedef struct {
    size_t event_queue_size;   /* 0 = default 64 */
    size_t max_tiles;          /* 0 = default 256; LRU cache (P4.2 eviction) */
    size_t max_overlays;       /* 0 = default 4096; dynamic features */
    size_t max_layers_per_tile;/* 0 = default 32 */
} webmap_config_t;

webmap_config_t webmap_default_config(void);

/* ── Coordinate systems ────────────────────────────────────────────── */

/** WGS84 lon/lat in degrees. */
typedef struct {
    double lon;
    double lat;
} webmap_lonlat_t;

/** Web Mercator meters (EPSG:3857). */
typedef struct {
    double x;
    double y;
} webmap_mercator_t;

/** Normalized device / screen pixels. */
typedef struct {
    float x;
    float y;
} webmap_point2_t;

/** Slippy-map tile id (Web Mercator quadtree). */
typedef struct {
    uint8_t  z;
    uint32_t x;
    uint32_t y;
} webmap_tile_id_t;

/* ── Camera / viewport ─────────────────────────────────────────────── */

typedef struct {
    webmap_lonlat_t center;
    double          zoom;       /* continuous zoom; tile z = floor(zoom) */
    double          bearing;    /* degrees clockwise from north */
    double          pitch;      /* degrees from nadir; 0 = top-down */
    uint32_t        width_px;
    uint32_t        height_px;
} webmap_camera_t;

/* ── Layer and geometry kinds ──────────────────────────────────────── */

typedef enum {
    WEBMAP_LAYER_FILL   = 0,  /* polygons (landuse, buildings) */
    WEBMAP_LAYER_LINE   = 1,  /* polylines (roads, fiber, power) */
    WEBMAP_LAYER_POINT  = 2,  /* points (poles, ODFs, substations) */
    WEBMAP_LAYER_OVERLAY = 3  /* dynamic status features */
} webmap_layer_kind_t;

/**
 * Semantic class for rural utility status maps.
 * Basemap layers use WEBMAP_CLASS_BASEMAP; overlays use domain classes.
 */
typedef enum {
    WEBMAP_CLASS_BASEMAP       = 0,
    WEBMAP_CLASS_FIBER_SPAN    = 1,
    WEBMAP_CLASS_FIBER_NODE    = 2,
    WEBMAP_CLASS_FIBER_CPE     = 3,
    WEBMAP_CLASS_POWER_LINE    = 4,
    WEBMAP_CLASS_POWER_POLE    = 5,
    WEBMAP_CLASS_SUBSTATION    = 6,
    WEBMAP_CLASS_OUTAGE_ZONE   = 7,
    WEBMAP_CLASS_CUSTOMER      = 8,
    WEBMAP_CLASS_ALERT         = 9
} webmap_feature_class_t;

/** Operational status for dynamic overlays. */
typedef enum {
    WEBMAP_STATUS_UNKNOWN  = 0,
    WEBMAP_STATUS_OK       = 1,
    WEBMAP_STATUS_DEGRADED = 2,
    WEBMAP_STATUS_DOWN     = 3,
    WEBMAP_STATUS_MAINT    = 4
} webmap_status_t;

/* ── GPU-ready buffers (WebGPU-friendly) ───────────────────────────── */

/**
 * Interleaved vertex: tile-local position (extent 0..extent, typically 4096)
 * plus RGBA8 color. Host uploads as vertex buffer (float2 + unorm4 or u32).
 */
typedef struct {
    float    x;
    float    y;
    uint32_t rgba; /* 0xAABBGGRR little-endian packing for WGSL */
} webmap_vertex_t;

typedef struct {
    const webmap_vertex_t *vertices;
    size_t                 vertex_count;
    const uint32_t        *indices;
    size_t                 index_count;
    webmap_layer_kind_t    kind;
    webmap_feature_class_t  feature_class;
    char                   name[64];
    uint32_t               extent; /* MVT extent; default 4096 */
} webmap_gpu_layer_t;

/* ── Events (pull queue) ───────────────────────────────────────────── */

typedef enum {
    WEBMAP_EVENT_NONE = 0,
    WEBMAP_EVENT_TILE_LOADED,
    WEBMAP_EVENT_TILE_EVICTED,
    WEBMAP_EVENT_OVERLAY_UPSERTED,
    WEBMAP_EVENT_OVERLAY_REMOVED,
    WEBMAP_EVENT_CAMERA_CHANGED,
    WEBMAP_EVENT_NEED_TILE,       /* visible tile missing from cache */
    WEBMAP_EVENT_ERROR,
    WEBMAP_EVENT_QUEUE_OVERFLOW
} webmap_event_type_t;

typedef struct {
    webmap_event_type_t type;
    webmap_tile_id_t     tile;
    uint64_t            overlay_id;
    char                reason[128];
} webmap_event_t;

/* ── Opaque context ────────────────────────────────────────────────── */

typedef struct webmap_ctx webmap_ctx_t;

/* ── Lifecycle ─────────────────────────────────────────────────────── */

webmap_ctx_t *webmap_create(void);
webmap_ctx_t *webmap_create_with_config(const webmap_config_t *cfg);
void webmap_destroy(webmap_ctx_t *ctx);
void webmap_reset(webmap_ctx_t *ctx);

/* ── Camera ────────────────────────────────────────────────────────── */

void webmap_set_camera(webmap_ctx_t *ctx, const webmap_camera_t *cam);
void webmap_get_camera(const webmap_ctx_t *ctx, webmap_camera_t *out);

/**
 * Compute the inclusive tile range covering the camera frustum at floor(zoom).
 * Uses width_px/height_px and Web Mercator (256px tiles). Returns 0 on success.
 */
int webmap_visible_tile_range(const webmap_camera_t *cam,
                              webmap_tile_id_t *min_out,
                              webmap_tile_id_t *max_out);

/** Recompute visible tile set; emits NEED_TILE for cache misses. */
int webmap_update_visible_tiles(webmap_ctx_t *ctx);

/**
 * List tiles currently held in the cache (up to max_out).
 * Returns number written.
 */
size_t webmap_list_tiles(const webmap_ctx_t *ctx, webmap_tile_id_t *out,
                         size_t max_out);

/* ── Projection helpers (pure math; no I/O) ────────────────────────── */

void webmap_lonlat_to_mercator(webmap_lonlat_t ll, webmap_mercator_t *out);
void webmap_mercator_to_lonlat(webmap_mercator_t m, webmap_lonlat_t *out);
void webmap_lonlat_to_tile(webmap_lonlat_t ll, uint8_t z, webmap_tile_id_t *out);
void webmap_tile_bounds_lonlat(webmap_tile_id_t id,
                              webmap_lonlat_t *sw, webmap_lonlat_t *ne);
uint32_t webmap_tile_count_at_zoom(uint8_t z);

/* ── Basemap tile ingest (.wmap binary) ────────────────────────────── */

/**
 * Load one preconverted tile from a .wmap blob (in-memory).
 * Replaces any existing tile with the same id. Returns 0 on success.
 */
int webmap_load_wmap_tile(webmap_ctx_t *ctx, const uint8_t *data, size_t len);

/**
 * Drop one cached tile by id (P4.13 host decode-and-drop).
 * Frees geometry retained in the library tile cache after the host has
 * copied or uploaded layers. Returns 0 if dropped, 1 if not present, -1 on error.
 */
int webmap_drop_tile(webmap_ctx_t *ctx, webmap_tile_id_t id);

/** Number of tiles currently held. */
size_t webmap_tile_count(const webmap_ctx_t *ctx);

/** Look up a loaded tile's GPU layers. Returns layer count; fills up to max. */
size_t webmap_get_tile_layers(const webmap_ctx_t *ctx, webmap_tile_id_t id,
                             webmap_gpu_layer_t *out, size_t max_layers);

/* ── Dynamic overlays (fiber / electric status) ────────────────────── */

typedef struct {
    uint64_t               id;       /* stable id from upstream system */
    webmap_feature_class_t feature_class;
    webmap_status_t         status;
    webmap_layer_kind_t     kind;
    /**
     * Geometry in WGS84: for POINT, n_points=1; for LINE/FILL, ring/path.
     * Caller retains ownership of points during the call only (copied in).
     */
    const webmap_lonlat_t *points;
    size_t                 n_points;
    char                   label[96];
    uint32_t               rgba;     /* 0 = derive from status */
} webmap_overlay_desc_t;

int webmap_upsert_overlay(webmap_ctx_t *ctx, const webmap_overlay_desc_t *desc);
int webmap_remove_overlay(webmap_ctx_t *ctx, uint64_t id);
size_t webmap_overlay_count(const webmap_ctx_t *ctx);

/**
 * Build GPU-ready geometry for all overlays visible in the current camera.
 * Vertices are in Web Mercator meters relative to camera center (float).
 * Returns number of layers written (at most 1 aggregate per kind).
 */
size_t webmap_build_overlay_gpu(const webmap_ctx_t *ctx,
                                webmap_gpu_layer_t *out, size_t max_layers);

/* ── Events ────────────────────────────────────────────────────────── */

int webmap_next_event(webmap_ctx_t *ctx, webmap_event_t *ev);
int webmap_has_pending_events(const webmap_ctx_t *ctx);
size_t webmap_event_count(const webmap_ctx_t *ctx);
uint64_t webmap_dropped_count(const webmap_ctx_t *ctx);

/* ── .wmap format helpers (shared with gfvtile2wmap) ───────────────── */

#define WEBMAP_WMAP_MAGIC   0x50414D57u /* 'WMAP' little-endian */
#define WEBMAP_WMAP_VERSION 1u
#define WEBMAP_DEFAULT_EXTENT 4096u

/**
 * Serialize a single-tile .wmap blob into caller buffer.
 * Returns bytes written, or 0 on failure / insufficient buffer.
 */
size_t webmap_wmap_encode(webmap_tile_id_t id,
                          const webmap_gpu_layer_t *layers, size_t n_layers,
                          uint8_t *out, size_t out_cap);

/** Decode header only: returns 0 on success. */
int webmap_wmap_peek(const uint8_t *data, size_t len, webmap_tile_id_t *id,
                     uint32_t *n_layers);

const char *webmap_event_type_name(webmap_event_type_t type);
const char *webmap_status_name(webmap_status_t s);
const char *webmap_feature_class_name(webmap_feature_class_t c);

/* ── Status → color defaults ───────────────────────────────────────── */

uint32_t webmap_status_rgba(webmap_status_t s);

/* ── Schematic layout (P4.10 / ADR-020) ───────────────────────────────
 * See webmap_schematic.h — pure geometry from splice_detail JSON.
 * Included here for discoverability; full API is in that header.
 */
#include "webmap_schematic.h"

#ifdef __cplusplus
}
#endif

#endif /* LIBWEBMAP_H */
