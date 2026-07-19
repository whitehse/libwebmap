/**
 * @file webmap.c
 * @brief WebGPU-oriented map context: tiles, camera, overlays, .wmap I/O.
 */

#include "webmap.h"

#ifdef WEBMAP_WASM_FREESTANDING
/* Freestanding WASM: no libc headers; symbols from wasm/webmap_wasm_rt.c */
void *malloc(size_t n);
void free(void *p);
void *calloc(size_t nmemb, size_t size);
void *realloc(void *ptr, size_t size);
void *memcpy(void *dst, const void *src, size_t n);
void *memset(void *dst, int c, size_t n);
size_t strlen(const char *s);
double log(double x);
double tan(double x);
double cos(double x);
double atan(double x);
double exp(double x);
double sinh(double x);
double floor(double x);
#else
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#endif

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define WEBMAP_DEFAULT_Q       64u
#define WEBMAP_MAX_Q           256u
#define WEBMAP_DEFAULT_TILES   256u
#define WEBMAP_DEFAULT_OVERLAYS 4096u
#define WEBMAP_DEFAULT_LAYERS  32u
#define WEBMAP_EARTH_RADIUS    6378137.0
#define WEBMAP_MAX_LAT         85.05112878

/* ── Internal types ────────────────────────────────────────────────── */

typedef struct {
    webmap_gpu_layer_t meta;
    webmap_vertex_t   *verts;   /* owned */
    uint32_t          *inds;    /* owned */
} layer_slot_t;

typedef struct {
    webmap_tile_id_t id;
    int              used;
    layer_slot_t    *layers;
    size_t           n_layers;
    uint64_t         lru_stamp; /* higher = more recently used (P4.2) */
} tile_slot_t;

typedef struct {
    int                    used;
    uint64_t               id;
    webmap_feature_class_t feature_class;
    webmap_status_t        status;
    webmap_layer_kind_t     kind;
    webmap_lonlat_t        *points;
    size_t                 n_points;
    char                   label[96];
    uint32_t               rgba;
} overlay_slot_t;

struct webmap_ctx {
    size_t qsz;
    webmap_event_t *events;
    size_t head, tail, cnt;
    uint64_t dropped;

    size_t max_tiles;
    tile_slot_t *tiles;
    size_t tile_count;
    uint64_t lru_clock; /* monotonic stamp for tile LRU eviction */

    size_t max_overlays;
    overlay_slot_t *overlays;
    size_t overlay_count;

    size_t max_layers;

    webmap_camera_t camera;
    int camera_valid;

    /* Scratch for overlay GPU build (rebuilt each call). */
    webmap_vertex_t *ov_verts;
    size_t           ov_vert_cap;
    uint32_t        *ov_inds;
    size_t           ov_ind_cap;
    size_t           ov_vert_count;
    size_t           ov_ind_count;
};

/* ── Helpers ───────────────────────────────────────────────────────── */

webmap_config_t webmap_default_config(void)
{
    webmap_config_t c;
    c.event_queue_size = WEBMAP_DEFAULT_Q;
    c.max_tiles = WEBMAP_DEFAULT_TILES;
    c.max_overlays = WEBMAP_DEFAULT_OVERLAYS;
    c.max_layers_per_tile = WEBMAP_DEFAULT_LAYERS;
    return c;
}

const char *webmap_event_type_name(webmap_event_type_t type)
{
    switch (type) {
    case WEBMAP_EVENT_NONE: return "NONE";
    case WEBMAP_EVENT_TILE_LOADED: return "TILE_LOADED";
    case WEBMAP_EVENT_TILE_EVICTED: return "TILE_EVICTED";
    case WEBMAP_EVENT_OVERLAY_UPSERTED: return "OVERLAY_UPSERTED";
    case WEBMAP_EVENT_OVERLAY_REMOVED: return "OVERLAY_REMOVED";
    case WEBMAP_EVENT_CAMERA_CHANGED: return "CAMERA_CHANGED";
    case WEBMAP_EVENT_NEED_TILE: return "NEED_TILE";
    case WEBMAP_EVENT_ERROR: return "ERROR";
    case WEBMAP_EVENT_QUEUE_OVERFLOW: return "QUEUE_OVERFLOW";
    default: return "UNKNOWN";
    }
}

const char *webmap_status_name(webmap_status_t s)
{
    switch (s) {
    case WEBMAP_STATUS_UNKNOWN: return "unknown";
    case WEBMAP_STATUS_OK: return "ok";
    case WEBMAP_STATUS_DEGRADED: return "degraded";
    case WEBMAP_STATUS_DOWN: return "down";
    case WEBMAP_STATUS_MAINT: return "maint";
    default: return "unknown";
    }
}

const char *webmap_feature_class_name(webmap_feature_class_t c)
{
    switch (c) {
    case WEBMAP_CLASS_BASEMAP: return "basemap";
    case WEBMAP_CLASS_FIBER_SPAN: return "fiber_span";
    case WEBMAP_CLASS_FIBER_NODE: return "fiber_node";
    case WEBMAP_CLASS_FIBER_CPE: return "fiber_cpe";
    case WEBMAP_CLASS_POWER_LINE: return "power_line";
    case WEBMAP_CLASS_POWER_POLE: return "power_pole";
    case WEBMAP_CLASS_SUBSTATION: return "substation";
    case WEBMAP_CLASS_OUTAGE_ZONE: return "outage_zone";
    case WEBMAP_CLASS_CUSTOMER: return "customer";
    case WEBMAP_CLASS_ALERT: return "alert";
    default: return "unknown";
    }
}

uint32_t webmap_status_rgba(webmap_status_t s)
{
    /* 0xAABBGGRR */
    switch (s) {
    case WEBMAP_STATUS_OK: return 0xFF2ECC71u;       /* green */
    case WEBMAP_STATUS_DEGRADED: return 0xFFF1C40Fu; /* yellow */
    case WEBMAP_STATUS_DOWN: return 0xFFE74C3Cu;     /* red */
    case WEBMAP_STATUS_MAINT: return 0xFF3498DBu;    /* blue */
    default: return 0xFF95A5A6u;                     /* gray */
    }
}

static void emit_event(struct webmap_ctx *c, const webmap_event_t *ev)
{
    if (c->cnt >= c->qsz) {
        webmap_event_t overflow;
        memset(&overflow, 0, sizeof(overflow));
        overflow.type = WEBMAP_EVENT_QUEUE_OVERFLOW;
        {
            static const char msg[] = "event queue full";
            size_t i;
            for (i = 0; i + 1 < sizeof(overflow.reason) && msg[i]; i++) {
                overflow.reason[i] = msg[i];
            }
            overflow.reason[i] = '\0';
        }
        c->events[c->head] = overflow;
        c->dropped++;
        return;
    }
    c->events[c->tail] = *ev;
    c->tail = (c->tail + 1) % c->qsz;
    c->cnt++;
}

/* ── Projection ────────────────────────────────────────────────────── */

void webmap_lonlat_to_mercator(webmap_lonlat_t ll, webmap_mercator_t *out)
{
    double lat = ll.lat;
    if (lat > WEBMAP_MAX_LAT) {
        lat = WEBMAP_MAX_LAT;
    }
    if (lat < -WEBMAP_MAX_LAT) {
        lat = -WEBMAP_MAX_LAT;
    }
    out->x = WEBMAP_EARTH_RADIUS * ll.lon * M_PI / 180.0;
    out->y = WEBMAP_EARTH_RADIUS *
             log(tan(M_PI / 4.0 + lat * M_PI / 360.0));
}

void webmap_mercator_to_lonlat(webmap_mercator_t m, webmap_lonlat_t *out)
{
    out->lon = (m.x / WEBMAP_EARTH_RADIUS) * 180.0 / M_PI;
    out->lat = (2.0 * atan(exp(m.y / WEBMAP_EARTH_RADIUS)) - M_PI / 2.0) *
               180.0 / M_PI;
}

uint32_t webmap_tile_count_at_zoom(uint8_t z)
{
    if (z >= 31) {
        return 0xFFFFFFFFu;
    }
    return 1u << z;
}

void webmap_lonlat_to_tile(webmap_lonlat_t ll, uint8_t z, webmap_tile_id_t *out)
{
    double lat = ll.lat;
    double n, x, y;
    uint32_t ntiles;

    if (lat > WEBMAP_MAX_LAT) {
        lat = WEBMAP_MAX_LAT;
    }
    if (lat < -WEBMAP_MAX_LAT) {
        lat = -WEBMAP_MAX_LAT;
    }
    ntiles = webmap_tile_count_at_zoom(z);
    n = (double)ntiles;
    x = (ll.lon + 180.0) / 360.0 * n;
    y = (1.0 - log(tan(lat * M_PI / 180.0) + 1.0 / cos(lat * M_PI / 180.0)) /
                       M_PI) /
        2.0 * n;
    out->z = z;
    out->x = (uint32_t)x;
    out->y = (uint32_t)y;
    if (out->x >= ntiles) {
        out->x = ntiles - 1;
    }
    if (out->y >= ntiles) {
        out->y = ntiles - 1;
    }
}

void webmap_tile_bounds_lonlat(webmap_tile_id_t id, webmap_lonlat_t *sw,
                               webmap_lonlat_t *ne)
{
    double n = (double)webmap_tile_count_at_zoom(id.z);
    double lon_w = id.x / n * 360.0 - 180.0;
    double lon_e = (id.x + 1) / n * 360.0 - 180.0;
    double lat_n = atan(sinh(M_PI * (1.0 - 2.0 * id.y / n))) * 180.0 / M_PI;
    double lat_s =
        atan(sinh(M_PI * (1.0 - 2.0 * (id.y + 1) / n))) * 180.0 / M_PI;
    sw->lon = lon_w;
    sw->lat = lat_s;
    ne->lon = lon_e;
    ne->lat = lat_n;
}

/* ── Lifecycle ─────────────────────────────────────────────────────── */

webmap_ctx_t *webmap_create(void)
{
    return webmap_create_with_config(NULL);
}

webmap_ctx_t *webmap_create_with_config(const webmap_config_t *cfg)
{
    struct webmap_ctx *c;
    webmap_config_t d = webmap_default_config();
    size_t qsz, mt, mo, ml;

    if (cfg) {
        if (cfg->event_queue_size) {
            d.event_queue_size = cfg->event_queue_size;
        }
        if (cfg->max_tiles) {
            d.max_tiles = cfg->max_tiles;
        }
        if (cfg->max_overlays) {
            d.max_overlays = cfg->max_overlays;
        }
        if (cfg->max_layers_per_tile) {
            d.max_layers_per_tile = cfg->max_layers_per_tile;
        }
    }

    qsz = d.event_queue_size;
    if (qsz > WEBMAP_MAX_Q) {
        qsz = WEBMAP_MAX_Q;
    }
    if (qsz == 0) {
        qsz = WEBMAP_DEFAULT_Q;
    }
    mt = d.max_tiles ? d.max_tiles : WEBMAP_DEFAULT_TILES;
    mo = d.max_overlays ? d.max_overlays : WEBMAP_DEFAULT_OVERLAYS;
    ml = d.max_layers_per_tile ? d.max_layers_per_tile : WEBMAP_DEFAULT_LAYERS;

    c = calloc(1, sizeof(*c));
    if (!c) {
        return NULL;
    }
    c->qsz = qsz;
    c->max_tiles = mt;
    c->max_overlays = mo;
    c->max_layers = ml;
    c->events = calloc(qsz, sizeof(webmap_event_t));
    c->tiles = calloc(mt, sizeof(tile_slot_t));
    c->overlays = calloc(mo, sizeof(overlay_slot_t));
    if (!c->events || !c->tiles || !c->overlays) {
        free(c->events);
        free(c->tiles);
        free(c->overlays);
        free(c);
        return NULL;
    }

    c->camera.center.lon = -97.5; /* rural OK / central plains default */
    c->camera.center.lat = 35.5;
    c->camera.zoom = 10.0;
    c->camera.width_px = 1280;
    c->camera.height_px = 720;
    c->camera_valid = 1;
    return c;
}

static void free_tile_slot(tile_slot_t *t)
{
    size_t i;
    if (!t || !t->used) {
        return;
    }
    for (i = 0; i < t->n_layers; i++) {
        free(t->layers[i].verts);
        free(t->layers[i].inds);
    }
    free(t->layers);
    memset(t, 0, sizeof(*t));
}

void webmap_destroy(webmap_ctx_t *ctx)
{
    size_t i;
    if (!ctx) {
        return;
    }
    for (i = 0; i < ctx->max_tiles; i++) {
        free_tile_slot(&ctx->tiles[i]);
    }
    for (i = 0; i < ctx->max_overlays; i++) {
        free(ctx->overlays[i].points);
    }
    free(ctx->events);
    free(ctx->tiles);
    free(ctx->overlays);
    free(ctx->ov_verts);
    free(ctx->ov_inds);
    free(ctx);
}

void webmap_reset(webmap_ctx_t *ctx)
{
    size_t i;
    if (!ctx) {
        return;
    }
    for (i = 0; i < ctx->max_tiles; i++) {
        free_tile_slot(&ctx->tiles[i]);
    }
    for (i = 0; i < ctx->max_overlays; i++) {
        free(ctx->overlays[i].points);
        memset(&ctx->overlays[i], 0, sizeof(ctx->overlays[i]));
    }
    ctx->tile_count = 0;
    ctx->overlay_count = 0;
    ctx->head = ctx->tail = ctx->cnt = 0;
    ctx->dropped = 0;
}

/* ── Camera ────────────────────────────────────────────────────────── */

void webmap_set_camera(webmap_ctx_t *ctx, const webmap_camera_t *cam)
{
    webmap_event_t ev;
    if (!ctx || !cam) {
        return;
    }
    ctx->camera = *cam;
    ctx->camera_valid = 1;
    memset(&ev, 0, sizeof(ev));
    ev.type = WEBMAP_EVENT_CAMERA_CHANGED;
    emit_event(ctx, &ev);
}

void webmap_get_camera(const webmap_ctx_t *ctx, webmap_camera_t *out)
{
    if (!ctx || !out) {
        return;
    }
    *out = ctx->camera;
}

static int tile_id_eq(webmap_tile_id_t a, webmap_tile_id_t b)
{
    return a.z == b.z && a.x == b.x && a.y == b.y;
}

static tile_slot_t *find_tile(struct webmap_ctx *c, webmap_tile_id_t id)
{
    size_t i;
    for (i = 0; i < c->max_tiles; i++) {
        if (c->tiles[i].used && tile_id_eq(c->tiles[i].id, id)) {
            return &c->tiles[i];
        }
    }
    return NULL;
}

/**
 * Visible tiles from camera width/height at floor(zoom).
 * World is 256 * 2^z CSS pixels; center is projected to world pixels,
 * then the viewport rectangle is converted to inclusive tile indices.
 */
int webmap_visible_tile_range(const webmap_camera_t *cam,
                              webmap_tile_id_t *min_out,
                              webmap_tile_id_t *max_out)
{
    uint8_t z;
    uint32_t ntiles;
    double scale, lat, lon, lat_rad, wx, wy;
    double half_w, half_h;
    double min_px, max_px, min_py, max_py;
    int32_t min_tx, max_tx, min_ty, max_ty;

    if (!cam || !min_out || !max_out) {
        return -1;
    }
    z = (uint8_t)cam->zoom;
    if (cam->zoom < 0) {
        z = 0;
    }
    if (z > 22) {
        z = 22;
    }
    ntiles = webmap_tile_count_at_zoom(z);
    if (ntiles == 0) {
        return -1;
    }

    scale = 256.0 * (double)ntiles;
    lon = cam->center.lon;
    lat = cam->center.lat;
    if (lat > WEBMAP_MAX_LAT) {
        lat = WEBMAP_MAX_LAT;
    }
    if (lat < -WEBMAP_MAX_LAT) {
        lat = -WEBMAP_MAX_LAT;
    }
    lat_rad = lat * M_PI / 180.0;
    wx = (lon + 180.0) / 360.0 * scale;
    wy = (1.0 - log(tan(lat_rad) + 1.0 / cos(lat_rad)) / M_PI) / 2.0 * scale;

    half_w = (cam->width_px > 0 ? (double)cam->width_px : 256.0) * 0.5;
    half_h = (cam->height_px > 0 ? (double)cam->height_px : 256.0) * 0.5;
    min_px = wx - half_w;
    max_px = wx + half_w;
    min_py = wy - half_h;
    max_py = wy + half_h;

    min_tx = (int32_t)floor(min_px / 256.0);
    max_tx = (int32_t)floor(max_px / 256.0);
    min_ty = (int32_t)floor(min_py / 256.0);
    max_ty = (int32_t)floor(max_py / 256.0);

    if (min_tx < 0) {
        min_tx = 0;
    }
    if (min_ty < 0) {
        min_ty = 0;
    }
    if (max_tx < 0) {
        max_tx = 0;
    }
    if (max_ty < 0) {
        max_ty = 0;
    }
    if ((uint32_t)max_tx >= ntiles) {
        max_tx = (int32_t)ntiles - 1;
    }
    if ((uint32_t)max_ty >= ntiles) {
        max_ty = (int32_t)ntiles - 1;
    }
    if ((uint32_t)min_tx >= ntiles) {
        min_tx = (int32_t)ntiles - 1;
    }
    if ((uint32_t)min_ty >= ntiles) {
        min_ty = (int32_t)ntiles - 1;
    }
    if (min_tx > max_tx) {
        int32_t t = min_tx;
        min_tx = max_tx;
        max_tx = t;
    }
    if (min_ty > max_ty) {
        int32_t t = min_ty;
        min_ty = max_ty;
        max_ty = t;
    }

    min_out->z = z;
    min_out->x = (uint32_t)min_tx;
    min_out->y = (uint32_t)min_ty;
    max_out->z = z;
    max_out->x = (uint32_t)max_tx;
    max_out->y = (uint32_t)max_ty;
    return 0;
}

int webmap_update_visible_tiles(webmap_ctx_t *ctx)
{
    webmap_tile_id_t tmin, tmax;
    uint32_t tx, ty;
    webmap_event_t ev;
    int need = 0;

    if (!ctx || !ctx->camera_valid) {
        return -1;
    }
    if (webmap_visible_tile_range(&ctx->camera, &tmin, &tmax) != 0) {
        return -1;
    }

    for (ty = tmin.y; ty <= tmax.y; ty++) {
        for (tx = tmin.x; tx <= tmax.x; tx++) {
            webmap_tile_id_t id;
            id.z = tmin.z;
            id.x = tx;
            id.y = ty;
            if (!find_tile(ctx, id)) {
                memset(&ev, 0, sizeof(ev));
                ev.type = WEBMAP_EVENT_NEED_TILE;
                ev.tile = id;
                emit_event(ctx, &ev);
                need++;
            }
        }
    }
    return need;
}

size_t webmap_list_tiles(const webmap_ctx_t *ctx, webmap_tile_id_t *out,
                         size_t max_out)
{
    size_t i, n = 0;
    if (!ctx || !out || max_out == 0) {
        return 0;
    }
    for (i = 0; i < ctx->max_tiles && n < max_out; i++) {
        if (ctx->tiles[i].used) {
            out[n++] = ctx->tiles[i].id;
        }
    }
    return n;
}

/* ── .wmap binary format ─────────────────────────────────────────────
 *
 * little-endian:
 *   u32 magic = 'WMAP'
 *   u32 version = 1
 *   u8  z
 *   u8  pad[3]
 *   u32 x
 *   u32 y
 *   u32 n_layers
 *   for each layer:
 *     u8  kind
 *     u8  feature_class
 *     u16 name_len
 *     char name[name_len]  (not NUL-padded in file; max 63 + NUL in struct)
 *     u32 extent
 *     u32 vertex_count
 *     u32 index_count
 *     vertex_count * webmap_vertex_t
 *     index_count * u32
 */

static size_t name_len_cap(const char *s, size_t cap)
{
    size_t n = 0;
    if (!s) {
        return 0;
    }
    while (n < cap && s[n] != '\0') {
        n++;
    }
    return n;
}

static uint32_t rd_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static void wr_u32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
    p[2] = (uint8_t)((v >> 16) & 0xFF);
    p[3] = (uint8_t)((v >> 24) & 0xFF);
}

static uint16_t rd_u16(const uint8_t *p)
{
    return (uint16_t)(p[0] | (p[1] << 8));
}

static void wr_u16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
}

int webmap_wmap_peek(const uint8_t *data, size_t len, webmap_tile_id_t *id,
                     uint32_t *n_layers)
{
    if (!data || len < 20) {
        return -1;
    }
    if (rd_u32(data) != WEBMAP_WMAP_MAGIC) {
        return -1;
    }
    if (rd_u32(data + 4) != WEBMAP_WMAP_VERSION) {
        return -1;
    }
    if (id) {
        id->z = data[8];
        id->x = rd_u32(data + 12);
        id->y = rd_u32(data + 16);
    }
    if (n_layers) {
        if (len < 24) {
            return -1;
        }
        *n_layers = rd_u32(data + 20);
    }
    return 0;
}

size_t webmap_wmap_encode(webmap_tile_id_t id, const webmap_gpu_layer_t *layers,
                          size_t n_layers, uint8_t *out, size_t out_cap)
{
    size_t need = 24;
    size_t i, off;
    size_t nlen;

    if (!layers && n_layers > 0) {
        return 0;
    }
    for (i = 0; i < n_layers; i++) {
        nlen = name_len_cap(layers[i].name, 63);
        need += 2 + 2 + nlen + 4 + 4 + 4;
        need += layers[i].vertex_count * sizeof(webmap_vertex_t);
        need += layers[i].index_count * sizeof(uint32_t);
    }
    if (!out || out_cap < need) {
        return 0;
    }

    wr_u32(out + 0, WEBMAP_WMAP_MAGIC);
    wr_u32(out + 4, WEBMAP_WMAP_VERSION);
    out[8] = id.z;
    out[9] = out[10] = out[11] = 0;
    wr_u32(out + 12, id.x);
    wr_u32(out + 16, id.y);
    wr_u32(out + 20, (uint32_t)n_layers);
    off = 24;

    for (i = 0; i < n_layers; i++) {
        const webmap_gpu_layer_t *L = &layers[i];
        nlen = name_len_cap(L->name, 63);
        out[off++] = (uint8_t)L->kind;
        out[off++] = (uint8_t)L->feature_class;
        wr_u16(out + off, (uint16_t)nlen);
        off += 2;
        memcpy(out + off, L->name, nlen);
        off += nlen;
        wr_u32(out + off, L->extent ? L->extent : WEBMAP_DEFAULT_EXTENT);
        off += 4;
        wr_u32(out + off, (uint32_t)L->vertex_count);
        off += 4;
        wr_u32(out + off, (uint32_t)L->index_count);
        off += 4;
        if (L->vertex_count) {
            memcpy(out + off, L->vertices,
                   L->vertex_count * sizeof(webmap_vertex_t));
            off += L->vertex_count * sizeof(webmap_vertex_t);
        }
        if (L->index_count) {
            memcpy(out + off, L->indices, L->index_count * sizeof(uint32_t));
            off += L->index_count * sizeof(uint32_t);
        }
    }
    return off;
}

/** Touch LRU stamp (call when tile is loaded or layers are read). */
static void touch_tile_lru(struct webmap_ctx *c, tile_slot_t *slot)
{
    if (!c || !slot || !slot->used) {
        return;
    }
    c->lru_clock++;
    if (c->lru_clock == 0) {
        /* wrap: re-normalize stamps (rare) */
        c->lru_clock = 1;
    }
    slot->lru_stamp = c->lru_clock;
}

static tile_slot_t *alloc_tile_slot(struct webmap_ctx *c)
{
    size_t i;
    size_t victim = (size_t)-1;
    uint64_t best;

    for (i = 0; i < c->max_tiles; i++) {
        if (!c->tiles[i].used) {
            return &c->tiles[i];
        }
    }
    /* Evict least-recently-used used slot (ADR-008 / P4.2). */
    best = ~(uint64_t)0;
    for (i = 0; i < c->max_tiles; i++) {
        if (c->tiles[i].used && c->tiles[i].lru_stamp < best) {
            best = c->tiles[i].lru_stamp;
            victim = i;
        }
    }
    if (victim != (size_t)-1) {
        webmap_event_t ev;
        memset(&ev, 0, sizeof(ev));
        ev.type = WEBMAP_EVENT_TILE_EVICTED;
        ev.tile = c->tiles[victim].id;
        emit_event(c, &ev);
        free_tile_slot(&c->tiles[victim]);
        c->tile_count--;
        return &c->tiles[victim];
    }
    return NULL;
}

int webmap_load_wmap_tile(webmap_ctx_t *ctx, const uint8_t *data, size_t len)
{
    webmap_tile_id_t id;
    uint32_t n_layers = 0;
    size_t off;
    size_t i;
    tile_slot_t *slot;
    webmap_event_t ev;

    if (!ctx || !data) {
        return -1;
    }
    if (webmap_wmap_peek(data, len, &id, &n_layers) != 0) {
        return -1;
    }
    if (n_layers > ctx->max_layers) {
        return -1;
    }

    slot = find_tile(ctx, id);
    if (slot) {
        free_tile_slot(slot);
        ctx->tile_count--;
    } else {
        slot = alloc_tile_slot(ctx);
        if (!slot) {
            return -1;
        }
    }

    slot->layers = calloc(n_layers ? n_layers : 1, sizeof(layer_slot_t));
    if (!slot->layers && n_layers > 0) {
        return -1;
    }
    slot->id = id;
    slot->used = 1;
    slot->n_layers = 0;
    off = 24;

    for (i = 0; i < n_layers; i++) {
        layer_slot_t *ls;
        uint16_t nlen, name_copy;
        uint32_t vc, ic, extent;
        size_t name_off;

        if (off + 4 > len) {
            free_tile_slot(slot);
            return -1;
        }
        ls = &slot->layers[slot->n_layers];
        memset(ls, 0, sizeof(*ls));
        ls->meta.kind = (webmap_layer_kind_t)data[off++];
        ls->meta.feature_class = (webmap_feature_class_t)data[off++];
        nlen = rd_u16(data + off);
        off += 2;
        if (off + nlen + 12 > len) {
            free_tile_slot(slot);
            return -1;
        }
        name_off = off;
        off += nlen;
        name_copy = nlen;
        if (name_copy >= sizeof(ls->meta.name)) {
            name_copy = (uint16_t)(sizeof(ls->meta.name) - 1);
        }
        memcpy(ls->meta.name, data + name_off, name_copy);
        ls->meta.name[name_copy] = '\0';

        extent = rd_u32(data + off);
        off += 4;
        vc = rd_u32(data + off);
        off += 4;
        ic = rd_u32(data + off);
        off += 4;
        ls->meta.extent = extent ? extent : WEBMAP_DEFAULT_EXTENT;

        if (off + vc * sizeof(webmap_vertex_t) + ic * sizeof(uint32_t) > len) {
            free_tile_slot(slot);
            return -1;
        }
        if (vc) {
            ls->verts = malloc(vc * sizeof(webmap_vertex_t));
            if (!ls->verts) {
                free_tile_slot(slot);
                return -1;
            }
            memcpy(ls->verts, data + off, vc * sizeof(webmap_vertex_t));
            off += vc * sizeof(webmap_vertex_t);
        }
        if (ic) {
            ls->inds = malloc(ic * sizeof(uint32_t));
            if (!ls->inds) {
                free_tile_slot(slot);
                return -1;
            }
            memcpy(ls->inds, data + off, ic * sizeof(uint32_t));
            off += ic * sizeof(uint32_t);
        }
        ls->meta.vertices = ls->verts;
        ls->meta.vertex_count = vc;
        ls->meta.indices = ls->inds;
        ls->meta.index_count = ic;
        slot->n_layers++;
    }

    ctx->tile_count++;
    touch_tile_lru(ctx, slot);
    memset(&ev, 0, sizeof(ev));
    ev.type = WEBMAP_EVENT_TILE_LOADED;
    ev.tile = id;
    emit_event(ctx, &ev);
    return 0;
}

int webmap_drop_tile(webmap_ctx_t *ctx, webmap_tile_id_t id)
{
    tile_slot_t *slot;
    webmap_event_t ev;

    if (!ctx) {
        return -1;
    }
    slot = find_tile(ctx, id);
    if (!slot) {
        return 1;
    }
    memset(&ev, 0, sizeof(ev));
    ev.type = WEBMAP_EVENT_TILE_EVICTED;
    ev.tile = id;
    free_tile_slot(slot);
    ctx->tile_count--;
    emit_event(ctx, &ev);
    return 0;
}

size_t webmap_tile_count(const webmap_ctx_t *ctx)
{
    return ctx ? ctx->tile_count : 0;
}

size_t webmap_get_tile_layers(const webmap_ctx_t *ctx, webmap_tile_id_t id,
                             webmap_gpu_layer_t *out, size_t max_layers)
{
    tile_slot_t *slot;
    size_t i, n;

    if (!ctx || !out || max_layers == 0) {
        return 0;
    }
    slot = find_tile((struct webmap_ctx *)ctx, id);
    if (!slot) {
        return 0;
    }
    /* Non-const touch for LRU — get_tile_layers is a cache use. */
    touch_tile_lru((struct webmap_ctx *)ctx, slot);
    n = slot->n_layers < max_layers ? slot->n_layers : max_layers;
    for (i = 0; i < n; i++) {
        out[i] = slot->layers[i].meta;
    }
    return n;
}

/* ── Overlays ──────────────────────────────────────────────────────── */

int webmap_upsert_overlay(webmap_ctx_t *ctx, const webmap_overlay_desc_t *desc)
{
    size_t i, free_i = (size_t)-1;
    overlay_slot_t *s;
    webmap_event_t ev;
    webmap_lonlat_t *pts;

    if (!ctx || !desc || !desc->points || desc->n_points == 0) {
        return -1;
    }

    for (i = 0; i < ctx->max_overlays; i++) {
        if (ctx->overlays[i].used && ctx->overlays[i].id == desc->id) {
            free_i = i;
            break;
        }
        if (!ctx->overlays[i].used && free_i == (size_t)-1) {
            free_i = i;
        }
    }
    if (free_i == (size_t)-1) {
        return -1;
    }

    pts = malloc(desc->n_points * sizeof(webmap_lonlat_t));
    if (!pts) {
        return -1;
    }
    memcpy(pts, desc->points, desc->n_points * sizeof(webmap_lonlat_t));

    s = &ctx->overlays[free_i];
    if (s->used) {
        free(s->points);
    } else {
        ctx->overlay_count++;
    }
    s->used = 1;
    s->id = desc->id;
    s->feature_class = desc->feature_class;
    s->status = desc->status;
    s->kind = desc->kind;
    s->points = pts;
    s->n_points = desc->n_points;
    memcpy(s->label, desc->label, sizeof(s->label));
    s->label[sizeof(s->label) - 1] = '\0';
    s->rgba = desc->rgba ? desc->rgba : webmap_status_rgba(desc->status);

    memset(&ev, 0, sizeof(ev));
    ev.type = WEBMAP_EVENT_OVERLAY_UPSERTED;
    ev.overlay_id = desc->id;
    emit_event(ctx, &ev);
    return 0;
}

int webmap_remove_overlay(webmap_ctx_t *ctx, uint64_t id)
{
    size_t i;
    webmap_event_t ev;
    if (!ctx) {
        return -1;
    }
    for (i = 0; i < ctx->max_overlays; i++) {
        if (ctx->overlays[i].used && ctx->overlays[i].id == id) {
            free(ctx->overlays[i].points);
            memset(&ctx->overlays[i], 0, sizeof(ctx->overlays[i]));
            ctx->overlay_count--;
            memset(&ev, 0, sizeof(ev));
            ev.type = WEBMAP_EVENT_OVERLAY_REMOVED;
            ev.overlay_id = id;
            emit_event(ctx, &ev);
            return 0;
        }
    }
    return -1;
}

size_t webmap_overlay_count(const webmap_ctx_t *ctx)
{
    return ctx ? ctx->overlay_count : 0;
}

static int ensure_ov_cap(struct webmap_ctx *c, size_t nv, size_t ni)
{
    if (nv > c->ov_vert_cap) {
        webmap_vertex_t *p = realloc(c->ov_verts, nv * sizeof(*p));
        if (!p) {
            return -1;
        }
        c->ov_verts = p;
        c->ov_vert_cap = nv;
    }
    if (ni > c->ov_ind_cap) {
        uint32_t *p = realloc(c->ov_inds, ni * sizeof(*p));
        if (!p) {
            return -1;
        }
        c->ov_inds = p;
        c->ov_ind_cap = ni;
    }
    return 0;
}

size_t webmap_build_overlay_gpu(const webmap_ctx_t *ctx, webmap_gpu_layer_t *out,
                                size_t max_layers)
{
    struct webmap_ctx *c = (struct webmap_ctx *)ctx;
    webmap_mercator_t origin;
    size_t i, j;
    size_t est_v = 0, est_i = 0;
    size_t base;

    if (!ctx || !out || max_layers == 0) {
        return 0;
    }

    webmap_lonlat_to_mercator(ctx->camera.center, &origin);

    for (i = 0; i < ctx->max_overlays; i++) {
        if (!ctx->overlays[i].used) {
            continue;
        }
        est_v += ctx->overlays[i].n_points;
        if (ctx->overlays[i].kind == WEBMAP_LAYER_LINE &&
            ctx->overlays[i].n_points >= 2) {
            est_i += (ctx->overlays[i].n_points - 1) * 2;
        } else if (ctx->overlays[i].kind == WEBMAP_LAYER_POINT) {
            est_i += 1;
        } else if (ctx->overlays[i].kind == WEBMAP_LAYER_FILL &&
                   ctx->overlays[i].n_points >= 3) {
            est_i += (ctx->overlays[i].n_points - 2) * 3;
        }
    }
    if (est_v == 0) {
        return 0;
    }
    if (ensure_ov_cap(c, est_v, est_i ? est_i : est_v) != 0) {
        return 0;
    }
    c->ov_vert_count = 0;
    c->ov_ind_count = 0;

    for (i = 0; i < ctx->max_overlays; i++) {
        const overlay_slot_t *o = &ctx->overlays[i];
        if (!o->used) {
            continue;
        }
        base = c->ov_vert_count;
        for (j = 0; j < o->n_points; j++) {
            webmap_mercator_t m;
            webmap_vertex_t *v;
            webmap_lonlat_to_mercator(o->points[j], &m);
            v = &c->ov_verts[c->ov_vert_count++];
            v->x = (float)(m.x - origin.x);
            v->y = (float)(m.y - origin.y);
            v->rgba = o->rgba;
        }
        if (o->kind == WEBMAP_LAYER_LINE) {
            for (j = 0; j + 1 < o->n_points; j++) {
                c->ov_inds[c->ov_ind_count++] = (uint32_t)(base + j);
                c->ov_inds[c->ov_ind_count++] = (uint32_t)(base + j + 1);
            }
        } else if (o->kind == WEBMAP_LAYER_POINT) {
            c->ov_inds[c->ov_ind_count++] = (uint32_t)base;
        } else if (o->kind == WEBMAP_LAYER_FILL && o->n_points >= 3) {
            for (j = 1; j + 1 < o->n_points; j++) {
                c->ov_inds[c->ov_ind_count++] = (uint32_t)base;
                c->ov_inds[c->ov_ind_count++] = (uint32_t)(base + j);
                c->ov_inds[c->ov_ind_count++] = (uint32_t)(base + j + 1);
            }
        }
    }

    memset(&out[0], 0, sizeof(out[0]));
    out[0].vertices = c->ov_verts;
    out[0].vertex_count = c->ov_vert_count;
    out[0].indices = c->ov_inds;
    out[0].index_count = c->ov_ind_count;
    out[0].kind = WEBMAP_LAYER_OVERLAY;
    out[0].feature_class = WEBMAP_CLASS_ALERT;
    {
        static const char nm[] = "overlays";
        size_t i;
        for (i = 0; i + 1 < sizeof(out[0].name) && nm[i]; i++) {
            out[0].name[i] = nm[i];
        }
        out[0].name[i] = '\0';
    }
    out[0].extent = 0; /* meters relative to camera center */
    return 1;
}

/* ── Events ────────────────────────────────────────────────────────── */

int webmap_next_event(webmap_ctx_t *ctx, webmap_event_t *ev)
{
    if (!ctx || !ev) {
        return -1;
    }
    if (ctx->cnt == 0) {
        return 0;
    }
    *ev = ctx->events[ctx->head];
    ctx->head = (ctx->head + 1) % ctx->qsz;
    ctx->cnt--;
    return 1;
}

int webmap_has_pending_events(const webmap_ctx_t *ctx)
{
    return ctx && ctx->cnt > 0;
}

size_t webmap_event_count(const webmap_ctx_t *ctx)
{
    return ctx ? ctx->cnt : 0;
}

uint64_t webmap_dropped_count(const webmap_ctx_t *ctx)
{
    return ctx ? ctx->dropped : 0;
}
