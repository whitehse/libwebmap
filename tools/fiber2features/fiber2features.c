/*
 * fiber2features.c
 *
 * Tier B bake tool (ADR-017): read CrescentLink-normalized fiber design SQLite
 * (ECOEC conventions; docs/formats/fiber-design-input.md) and emit a data-only
 * fiber map package (.fmap + features.sqlite). No display policy.
 *
 * Normative .fmap layout: docs/formats/fmap.md
 * Map tables DDL: tools/schema/schema_map.sql (embedded via schema_map_sql.c)
 *
 * Output:
 *   OUT/{z}/{x}/{y}.fmap
 *   OUT/manifest.json
 *   OUT/features.sqlite   (map_cables + map_taps + map_splices)
 *   OUT/diagram_index.json  (splicepoint guid → diagram HTML basename)
 *
 * Build: cmake --build build --target fiber2features
 * Usage: ./build/fiber2features fiber_design.sqlite -o OUT_DIR
 */

#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>

#include "sqlite3.h"

/* Generated from tools/schema/schema_map.sql */
extern const char webmap_schema_map_sql[];

#define FMAP_MAGIC   0x50414D46u /* 'FMAP' LE */
#define FMAP_VERSION 2u
#define FMAP_EXTENT  4096u

#define EARTH_R 6378137.0
#define MAX_LAT 85.05112878
#define US_FT   0.3048006096012192

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

struct options {
    const char *input;
    const char *outdir;
    int zmin, zmax, tap_zmin, splice_zmin, limit;
    uint32_t extent;
    bool do_cables, do_drops, do_taps, do_splices;
    bool quiet;
    bool have_bbox;
    double bbox_w, bbox_s, bbox_e, bbox_n;
};

/* ── UUID + diagram filename helpers ───────────────────────────────── */

static int hex_nibble(char c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}

/** Parse 8-4-4-4-12 UUID text into 16 bytes. Returns 0 on success. */
static int parse_uuid_bytes(const char *s, uint8_t out[16])
{
    if (!s || !out)
        return -1;
    int n = 0;
    for (size_t i = 0; s[i] && n < 16;) {
        if (s[i] == '-') {
            i++;
            continue;
        }
        int hi = hex_nibble(s[i]);
        int lo = hex_nibble(s[i + 1]);
        if (hi < 0 || lo < 0)
            return -1;
        out[n++] = (uint8_t)((hi << 4) | lo);
        i += 2;
    }
    return n == 16 ? 0 : -1;
}

/**
 * Match splice_diagram sd_diagram_filename():
 *   sp_<station_or_guid>_<guid8>.html
 */
static void diagram_filename(const char *station, const char *guid, char *out,
                             size_t outsz)
{
    if (!out || outsz < 16)
        return;
    const char *src = (station && station[0]) ? station : (guid ? guid : "sp");
    size_t j = 0;
    out[j++] = 's';
    out[j++] = 'p';
    out[j++] = '_';
    for (size_t i = 0; src[i] && j + 14 < outsz; i++) {
        unsigned char c = (unsigned char)src[i];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_') {
            out[j++] = (char)c;
        } else {
            out[j++] = '_';
        }
    }
    if (guid && j + 12 < outsz) {
        out[j++] = '_';
        for (int i = 0; i < 8 && guid[i]; i++)
            out[j++] = guid[i];
    }
    snprintf(out + j, outsz - j, ".html");
}

/* ── Colors (data attributes baked as packed RGBA for compact tiles) ─ */

static uint32_t rgba8(uint8_t r, uint8_t g, uint8_t b, uint8_t a)
{
    return ((uint32_t)a << 24) | ((uint32_t)b << 16) | ((uint32_t)g << 8) | r;
}

static uint32_t color_splice_node(void)
{
    /* Slate blue — data hint only; host may restyle diamonds. */
    return rgba8(0x4A, 0x6F, 0xA5, 0xFF);
}

static uint32_t color_for_cable_size(int size)
{
    if (size <= 4)
        return rgba8(0x5B, 0xC0, 0xEB, 0xFF);
    if (size <= 12)
        return rgba8(0x2E, 0x86, 0xAB, 0xFF);
    if (size <= 24)
        return rgba8(0x3B, 0xCE, 0xAC, 0xFF);
    if (size <= 48)
        return rgba8(0xF4, 0xA2, 0x61, 0xFF);
    if (size <= 96)
        return rgba8(0xE7, 0x6F, 0x51, 0xFF);
    return rgba8(0x9B, 0x5D, 0xE5, 0xFF);
}

static uint32_t tia_color(const char *name)
{
    if (!name || !*name)
        return rgba8(0x88, 0x88, 0x88, 0xFF);
    char b[32];
    size_t n = 0;
    for (; name[n] && n + 1 < sizeof(b); n++) {
        char c = name[n];
        if (c >= 'A' && c <= 'Z')
            c = (char)(c - 'A' + 'a');
        b[n] = c;
    }
    b[n] = '\0';
    if (!strcmp(b, "blue"))
        return rgba8(0x00, 0x70, 0xC0, 0xFF);
    if (!strcmp(b, "orange"))
        return rgba8(0xFF, 0x8C, 0x00, 0xFF);
    if (!strcmp(b, "green"))
        return rgba8(0x00, 0xA6, 0x51, 0xFF);
    if (!strcmp(b, "brown"))
        return rgba8(0x8B, 0x45, 0x13, 0xFF);
    if (!strcmp(b, "slate") || !strcmp(b, "grey") || !strcmp(b, "gray"))
        return rgba8(0x70, 0x80, 0x90, 0xFF);
    if (!strcmp(b, "white"))
        return rgba8(0xF5, 0xF5, 0xF5, 0xFF);
    if (!strcmp(b, "red"))
        return rgba8(0xE3, 0x1C, 0x23, 0xFF);
    if (!strcmp(b, "black"))
        return rgba8(0x22, 0x22, 0x22, 0xFF);
    if (!strcmp(b, "yellow"))
        return rgba8(0xFF, 0xD7, 0x00, 0xFF);
    if (!strcmp(b, "violet") || !strcmp(b, "purple"))
        return rgba8(0x8B, 0x00, 0xFF, 0xFF);
    if (!strcmp(b, "rose") || !strcmp(b, "pink"))
        return rgba8(0xFF, 0x69, 0xB4, 0xFF);
    if (!strcmp(b, "aqua") || !strcmp(b, "cyan"))
        return rgba8(0x00, 0xCE, 0xD1, 0xFF);
    return rgba8(0x88, 0x88, 0x88, 0xFF);
}

/* ── CRS EPSG:2267 ─────────────────────────────────────────────────── */

typedef struct {
    double a, e, e2, n, F, rho0, lam0, FE, FN;
} ok_north_t;

static double ok_m(const ok_north_t *p, double phi)
{
    double s = sin(phi);
    return cos(phi) / sqrt(1.0 - p->e2 * s * s);
}

static double ok_t(const ok_north_t *p, double phi)
{
    double s = sin(phi);
    return tan(M_PI / 4.0 - phi / 2.0) /
           pow((1.0 - p->e * s) / (1.0 + p->e * s), p->e / 2.0);
}

static void ok_north_init(ok_north_t *p)
{
    p->a = 6378137.0;
    double f = 1.0 / 298.257222101;
    p->e2 = f * (2.0 - f);
    p->e = sqrt(p->e2);
    double phi1 = (35.0 + 34.0 / 60.0) * M_PI / 180.0;
    double phi2 = (36.0 + 46.0 / 60.0) * M_PI / 180.0;
    double phi0 = 35.0 * M_PI / 180.0;
    p->lam0 = -98.0 * M_PI / 180.0;
    p->FE = 1968500.0 * US_FT;
    p->FN = 0.0;
    double m1 = ok_m(p, phi1), m2 = ok_m(p, phi2);
    double t1 = ok_t(p, phi1), t2 = ok_t(p, phi2), t0 = ok_t(p, phi0);
    p->n = (log(m1) - log(m2)) / (log(t1) - log(t2));
    p->F = m1 / (p->n * pow(t1, p->n));
    p->rho0 = p->a * p->F * pow(t0, p->n);
}

/** Inverse: source coords are US survey feet (EPSG:2267). */
static void ok_north_inv(const ok_north_t *p, double x_ft, double y_ft,
                         double *lon_deg, double *lat_deg)
{
    double x = x_ft * US_FT - p->FE;
    double y = y_ft * US_FT - p->FN;
    double rho = hypot(x, p->rho0 - y);
    if (p->n < 0)
        rho = -rho;
    double theta = atan2(x, p->rho0 - y);
    double t = pow(rho / (p->a * p->F), 1.0 / p->n);
    double phi = M_PI / 2.0 - 2.0 * atan(t);
    for (int i = 0; i < 12; i++) {
        double s = sin(phi);
        double phi_n =
            M_PI / 2.0 -
            2.0 * atan(t * pow((1.0 - p->e * s) / (1.0 + p->e * s), p->e / 2.0));
        if (fabs(phi_n - phi) < 1e-12)
            break;
        phi = phi_n;
    }
    double lam = p->lam0 + theta / p->n;
    *lon_deg = lam * 180.0 / M_PI;
    *lat_deg = phi * 180.0 / M_PI;
}

static void lonlat_to_tile_xy(double lon, double lat, uint8_t z, double *tx,
                              double *ty)
{
    if (lat > MAX_LAT)
        lat = MAX_LAT;
    if (lat < -MAX_LAT)
        lat = -MAX_LAT;
    double n = (double)(1u << z);
    *tx = (lon + 180.0) / 360.0 * n;
    double lat_r = lat * M_PI / 180.0;
    *ty = (1.0 - log(tan(lat_r) + 1.0 / cos(lat_r)) / M_PI) / 2.0 * n;
}

static void lonlat_to_tile_local(double lon, double lat, uint8_t z, uint32_t tx,
                                 uint32_t ty, uint32_t extent, float *out_x,
                                 float *out_y)
{
    double fx, fy;
    lonlat_to_tile_xy(lon, lat, z, &fx, &fy);
    *out_x = (float)((fx - (double)tx) * (double)extent);
    *out_y = (float)((fy - (double)ty) * (double)extent);
}

/* ── Path / WKB ────────────────────────────────────────────────────── */

typedef struct {
    double *xy;
    size_t n, cap;
} path_t;

static void path_free(path_t *p)
{
    free(p->xy);
    memset(p, 0, sizeof(*p));
}

static int path_push(path_t *p, double x, double y)
{
    if (p->n + 1 > p->cap) {
        size_t nc = p->cap ? p->cap * 2 : 32;
        double *q = realloc(p->xy, nc * 2 * sizeof(double));
        if (!q)
            return -1;
        p->xy = q;
        p->cap = nc;
    }
    p->xy[p->n * 2] = x;
    p->xy[p->n * 2 + 1] = y;
    p->n++;
    return 0;
}

static int path_push_sep(path_t *p) { return path_push(p, NAN, NAN); }

static const uint8_t *gpkg_to_wkb(const uint8_t *blob, int len, int *wkb_len)
{
    if (!blob || len < 8)
        return NULL;
    if (blob[0] == 0 || blob[0] == 1) {
        if (len > 5) {
            *wkb_len = len;
            return blob;
        }
        return NULL;
    }
    if (blob[0] != 'G' || blob[1] != 'P')
        return NULL;
    uint8_t flags = blob[3];
    int env = (flags >> 1) & 0x07;
    static const int env_sizes[] = {0, 32, 48, 48, 64};
    int off = 8;
    if (env >= 0 && env <= 4)
        off += env_sizes[env];
    if (off >= len)
        return NULL;
    *wkb_len = len - off;
    return blob + off;
}

static uint32_t wkb_u32(const uint8_t *p, int le)
{
    if (le)
        return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
               ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

static double wkb_f64(const uint8_t *p, int le)
{
    union {
        uint64_t u;
        double d;
    } v;
    if (le) {
        v.u = (uint64_t)p[0] | ((uint64_t)p[1] << 8) | ((uint64_t)p[2] << 16) |
              ((uint64_t)p[3] << 24) | ((uint64_t)p[4] << 32) |
              ((uint64_t)p[5] << 40) | ((uint64_t)p[6] << 48) |
              ((uint64_t)p[7] << 56);
    } else {
        v.u = ((uint64_t)p[0] << 56) | ((uint64_t)p[1] << 48) |
              ((uint64_t)p[2] << 40) | ((uint64_t)p[3] << 32) |
              ((uint64_t)p[4] << 24) | ((uint64_t)p[5] << 16) |
              ((uint64_t)p[6] << 8) | (uint64_t)p[7];
    }
    return v.d;
}

static int wkb_decode_path(const uint8_t *wkb, int len, path_t *out)
{
    path_free(out);
    if (!wkb || len < 9)
        return -1;
    int le = wkb[0] == 1;
    if (wkb[0] != 0 && wkb[0] != 1)
        return -1;
    uint32_t gtype = wkb_u32(wkb + 1, le);
    uint32_t base = gtype & 0xFFu;
    if (base == 0)
        base = gtype % 1000;
    int dims = 2;
    int off = 5;
    int step = dims * 8;

    if (base == 1) {
        if (off + step > len)
            return -1;
        return path_push(out, wkb_f64(wkb + off, le), wkb_f64(wkb + off + 8, le));
    }
    if (base == 2) {
        if (off + 4 > len)
            return -1;
        uint32_t n = wkb_u32(wkb + off, le);
        off += 4;
        for (uint32_t i = 0; i < n; i++) {
            if (off + step > len)
                return -1;
            if (path_push(out, wkb_f64(wkb + off, le),
                          wkb_f64(wkb + off + 8, le)) != 0)
                return -1;
            off += step;
        }
        return out->n >= 2 ? 0 : -1;
    }
    if (base == 5) {
        if (off + 4 > len)
            return -1;
        uint32_t nparts = wkb_u32(wkb + off, le);
        off += 4;
        for (uint32_t p = 0; p < nparts; p++) {
            if (off + 9 > len)
                return -1;
            int ple = wkb[off] == 1;
            off += 5;
            uint32_t n = wkb_u32(wkb + off, ple);
            off += 4;
            if (out->n > 0 && path_push_sep(out) != 0)
                return -1;
            for (uint32_t i = 0; i < n; i++) {
                if (off + 16 > len)
                    return -1;
                if (path_push(out, wkb_f64(wkb + off, ple),
                              wkb_f64(wkb + off + 8, ple)) != 0)
                    return -1;
                off += 16;
            }
        }
        return out->n >= 2 ? 0 : -1;
    }
    return -1;
}

/* ── Feature records per tile ──────────────────────────────────────── */

typedef struct {
    float *xy; /* tile-local */
    uint16_t n_pts;
    uint16_t size;
    uint32_t rgba;
} line_feat_t;

typedef struct {
    float x, y;
    uint8_t ports;
    uint32_t strand_rgba;
    uint32_t tube_rgba;
    uint8_t sp_guid[16];
} tap_feat_t;

typedef struct {
    float x, y;
    uint32_t rgba;
    uint8_t sp_guid[16];
} splice_feat_t;

typedef struct {
    line_feat_t *v;
    size_t n, cap;
} line_list_t;

typedef struct {
    tap_feat_t *v;
    size_t n, cap;
} tap_list_t;

typedef struct {
    splice_feat_t *v;
    size_t n, cap;
} splice_list_t;

typedef struct tile {
    uint32_t x, y;
    line_list_t cables;
    line_list_t drops;
    tap_list_t taps;
    splice_list_t splices;
    struct tile *next;
} tile_t;

typedef struct {
    tile_t **buckets;
    size_t nbuckets;
    uint8_t z;
    uint32_t extent;
} tile_map_t;

static int line_list_push(line_list_t *L, const float *xy, uint16_t n_pts,
                          uint16_t size, uint32_t rgba)
{
    if (n_pts < 2)
        return 0;
    if (L->n >= L->cap) {
        size_t nc = L->cap ? L->cap * 2 : 64;
        line_feat_t *p = realloc(L->v, nc * sizeof(*p));
        if (!p)
            return -1;
        L->v = p;
        L->cap = nc;
    }
    float *copy = malloc((size_t)n_pts * 2 * sizeof(float));
    if (!copy)
        return -1;
    memcpy(copy, xy, (size_t)n_pts * 2 * sizeof(float));
    L->v[L->n].xy = copy;
    L->v[L->n].n_pts = n_pts;
    L->v[L->n].size = size;
    L->v[L->n].rgba = rgba;
    L->n++;
    return 0;
}

static int tap_list_push(tap_list_t *T, float x, float y, uint8_t ports,
                         uint32_t strand, uint32_t tube, const uint8_t sp_guid[16])
{
    if (T->n >= T->cap) {
        size_t nc = T->cap ? T->cap * 2 : 64;
        tap_feat_t *p = realloc(T->v, nc * sizeof(*p));
        if (!p)
            return -1;
        T->v = p;
        T->cap = nc;
    }
    tap_feat_t *t = &T->v[T->n++];
    t->x = x;
    t->y = y;
    t->ports = ports;
    t->strand_rgba = strand;
    t->tube_rgba = tube;
    if (sp_guid)
        memcpy(t->sp_guid, sp_guid, 16);
    else
        memset(t->sp_guid, 0, 16);
    return 0;
}

static int splice_list_push(splice_list_t *S, float x, float y, uint32_t rgba,
                            const uint8_t sp_guid[16])
{
    if (S->n >= S->cap) {
        size_t nc = S->cap ? S->cap * 2 : 64;
        splice_feat_t *p = realloc(S->v, nc * sizeof(*p));
        if (!p)
            return -1;
        S->v = p;
        S->cap = nc;
    }
    splice_feat_t *s = &S->v[S->n++];
    s->x = x;
    s->y = y;
    s->rgba = rgba;
    if (sp_guid)
        memcpy(s->sp_guid, sp_guid, 16);
    else
        memset(s->sp_guid, 0, 16);
    return 0;
}

static void line_list_free(line_list_t *L)
{
    for (size_t i = 0; i < L->n; i++)
        free(L->v[i].xy);
    free(L->v);
    memset(L, 0, sizeof(*L));
}

static void tap_list_free(tap_list_t *T)
{
    free(T->v);
    memset(T, 0, sizeof(*T));
}

static void splice_list_free(splice_list_t *S)
{
    free(S->v);
    memset(S, 0, sizeof(*S));
}

static uint32_t hash_xy(uint32_t x, uint32_t y)
{
    uint32_t h = x * 0x9E3779B9u ^ y * 0x85EBCA6Bu;
    h ^= h >> 16;
    h *= 0x7FEB352Du;
    h ^= h >> 15;
    return h;
}

static int tile_map_init(tile_map_t *tm, uint8_t z, uint32_t extent)
{
    memset(tm, 0, sizeof(*tm));
    tm->z = z;
    tm->extent = extent;
    tm->nbuckets = 4096;
    tm->buckets = calloc(tm->nbuckets, sizeof(tile_t *));
    return tm->buckets ? 0 : -1;
}

static void tile_map_free(tile_map_t *tm)
{
    if (!tm->buckets)
        return;
    for (size_t i = 0; i < tm->nbuckets; i++) {
        tile_t *t = tm->buckets[i];
        while (t) {
            tile_t *n = t->next;
            line_list_free(&t->cables);
            line_list_free(&t->drops);
            tap_list_free(&t->taps);
            splice_list_free(&t->splices);
            free(t);
            t = n;
        }
    }
    free(tm->buckets);
    memset(tm, 0, sizeof(*tm));
}

static tile_t *tile_map_get(tile_map_t *tm, uint32_t x, uint32_t y, bool create)
{
    uint32_t h = hash_xy(x, y) % (uint32_t)tm->nbuckets;
    for (tile_t *t = tm->buckets[h]; t; t = t->next) {
        if (t->x == x && t->y == y)
            return t;
    }
    if (!create)
        return NULL;
    tile_t *t = calloc(1, sizeof(*t));
    if (!t)
        return NULL;
    t->x = x;
    t->y = y;
    t->next = tm->buckets[h];
    tm->buckets[h] = t;
    return t;
}

static bool lonlat_in_bbox(const struct options *opt, double lon, double lat)
{
    if (!opt->have_bbox)
        return true;
    return lon >= opt->bbox_w && lon <= opt->bbox_e && lat >= opt->bbox_s &&
           lat <= opt->bbox_n;
}

/* Emit one continuous polyline (no NaN seps) into covering tiles. */
static int emit_line_part(tile_map_t *tm, const ok_north_t *crs,
                          const double *xy_src, size_t n, uint16_t size,
                          uint32_t rgba, int is_drop, const struct options *opt)
{
    if (n < 2)
        return 0;
    double *ll = malloc(n * 2 * sizeof(double));
    if (!ll)
        return -1;
    double min_lon = 1e9, max_lon = -1e9, min_lat = 1e9, max_lat = -1e9;
    size_t valid = 0;
    for (size_t i = 0; i < n; i++) {
        double lon, lat;
        ok_north_inv(crs, xy_src[i * 2], xy_src[i * 2 + 1], &lon, &lat);
        if (!lonlat_in_bbox(opt, lon, lat) && opt->have_bbox)
            continue;
        ll[valid * 2] = lon;
        ll[valid * 2 + 1] = lat;
        if (lon < min_lon)
            min_lon = lon;
        if (lon > max_lon)
            max_lon = lon;
        if (lat < min_lat)
            min_lat = lat;
        if (lat > max_lat)
            max_lat = lat;
        valid++;
    }
    if (valid < 2) {
        free(ll);
        return 0;
    }
    n = valid;

    uint8_t z = tm->z;
    double fx0, fy0, fx1, fy1;
    lonlat_to_tile_xy(min_lon, max_lat, z, &fx0, &fy0);
    lonlat_to_tile_xy(max_lon, min_lat, z, &fx1, &fy1);
    int tx0 = (int)floor(fmin(fx0, fx1)) - 1;
    int ty0 = (int)floor(fmin(fy0, fy1)) - 1;
    int tx1 = (int)floor(fmax(fx0, fx1)) + 1;
    int ty1 = (int)floor(fmax(fy0, fy1)) + 1;
    if (tx0 < 0)
        tx0 = 0;
    if (ty0 < 0)
        ty0 = 0;
    int ntiles = 1 << z;
    if (tx1 >= ntiles)
        tx1 = ntiles - 1;
    if (ty1 >= ntiles)
        ty1 = ntiles - 1;

    float *local = malloc(n * 2 * sizeof(float));
    if (!local) {
        free(ll);
        return -1;
    }

    for (int tx = tx0; tx <= tx1; tx++) {
        for (int ty = ty0; ty <= ty1; ty++) {
            for (size_t i = 0; i < n; i++) {
                lonlat_to_tile_local(ll[i * 2], ll[i * 2 + 1], z, (uint32_t)tx,
                                     (uint32_t)ty, tm->extent, &local[i * 2],
                                     &local[i * 2 + 1]);
            }
            /* skip if entirely outside padded tile */
            float buf = (float)tm->extent * 0.05f;
            bool any = false;
            for (size_t i = 0; i < n; i++) {
                float x = local[i * 2], y = local[i * 2 + 1];
                if (x >= -buf && y >= -buf && x <= (float)tm->extent + buf &&
                    y <= (float)tm->extent + buf) {
                    any = true;
                    break;
                }
            }
            if (!any)
                continue;
            tile_t *tile = tile_map_get(tm, (uint32_t)tx, (uint32_t)ty, true);
            if (!tile) {
                free(local);
                free(ll);
                return -1;
            }
            line_list_t *L = is_drop ? &tile->drops : &tile->cables;
            if (line_list_push(L, local, (uint16_t)(n > 65535 ? 65535 : n), size,
                               rgba) != 0) {
                free(local);
                free(ll);
                return -1;
            }
        }
    }
    free(local);
    free(ll);
    return 0;
}

static int emit_path_lines(tile_map_t *tm, const ok_north_t *crs,
                           const path_t *src, uint16_t size, uint32_t rgba,
                           int is_drop, const struct options *opt)
{
    if (!src || src->n < 2)
        return 0;
    size_t start = 0;
    for (size_t i = 0; i <= src->n; i++) {
        int sep = (i == src->n) || isnan(src->xy[i * 2]);
        if (!sep)
            continue;
        size_t len = i - start;
        if (len >= 2) {
            if (emit_line_part(tm, crs, src->xy + start * 2, len, size, rgba,
                               is_drop, opt) != 0)
                return -1;
        }
        start = i + 1;
    }
    return 0;
}

static int emit_point_tiles(tile_map_t *tm, double lon, double lat,
                            const struct options *opt, int is_tap,
                            uint8_t ports, uint32_t strand, uint32_t tube,
                            uint32_t splice_rgba, const uint8_t sp_guid[16])
{
    if (!lonlat_in_bbox(opt, lon, lat))
        return 0;
    uint8_t z = tm->z;
    double fx, fy;
    lonlat_to_tile_xy(lon, lat, z, &fx, &fy);
    int tx0 = (int)floor(fx) - 1, ty0 = (int)floor(fy) - 1;
    int tx1 = (int)floor(fx) + 1, ty1 = (int)floor(fy) + 1;
    if (tx0 < 0)
        tx0 = 0;
    if (ty0 < 0)
        ty0 = 0;
    int ntiles = 1 << z;
    if (tx1 >= ntiles)
        tx1 = ntiles - 1;
    if (ty1 >= ntiles)
        ty1 = ntiles - 1;
    float buf = (float)tm->extent * 0.05f;
    for (int tx = tx0; tx <= tx1; tx++) {
        for (int ty = ty0; ty <= ty1; ty++) {
            float cx, cy;
            lonlat_to_tile_local(lon, lat, z, (uint32_t)tx, (uint32_t)ty,
                                 tm->extent, &cx, &cy);
            if (cx < -buf || cy < -buf || cx > (float)tm->extent + buf ||
                cy > (float)tm->extent + buf)
                continue;
            tile_t *tile = tile_map_get(tm, (uint32_t)tx, (uint32_t)ty, true);
            if (!tile)
                return -1;
            if (is_tap) {
                if (tap_list_push(&tile->taps, cx, cy, ports, strand, tube,
                                  sp_guid) != 0)
                    return -1;
            } else {
                if (splice_list_push(&tile->splices, cx, cy, splice_rgba,
                                     sp_guid) != 0)
                    return -1;
            }
        }
    }
    return 0;
}

static int emit_tap(tile_map_t *tm, double lon, double lat, uint8_t ports,
                    uint32_t strand, uint32_t tube, const uint8_t sp_guid[16],
                    const struct options *opt)
{
    return emit_point_tiles(tm, lon, lat, opt, 1, ports, strand, tube, 0,
                            sp_guid);
}

static int emit_splice(tile_map_t *tm, double lon, double lat, uint32_t rgba,
                       const uint8_t sp_guid[16], const struct options *opt)
{
    return emit_point_tiles(tm, lon, lat, opt, 0, 0, 0, 0, rgba, sp_guid);
}

/* ── Encode .fmap ──────────────────────────────────────────────────── */

static void wr_u32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v);
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static void wr_u16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v);
    p[1] = (uint8_t)(v >> 8);
}

/* Header = 40 bytes: magic,ver,z,pad,x,y,extent,n_cables,n_drops,n_taps,n_splices */
static size_t fmap_size_of(const tile_t *t)
{
    size_t n = 40;
    for (size_t i = 0; i < t->cables.n; i++)
        n += 8 + (size_t)t->cables.v[i].n_pts * 8;
    for (size_t i = 0; i < t->drops.n; i++)
        n += 8 + (size_t)t->drops.v[i].n_pts * 8;
    n += t->taps.n * 36;    /* x,y,ports,pad,strand,tube,guid16 */
    n += t->splices.n * 28; /* x,y,pad4,rgba,guid16 */
    return n;
}

static size_t fmap_encode(uint8_t z, uint32_t x, uint32_t y, uint32_t extent,
                          const tile_t *t, uint8_t *out, size_t cap)
{
    size_t need = fmap_size_of(t);
    if (!out || cap < need)
        return 0;
    wr_u32(out + 0, FMAP_MAGIC);
    wr_u32(out + 4, FMAP_VERSION);
    out[8] = z;
    out[9] = out[10] = out[11] = 0;
    wr_u32(out + 12, x);
    wr_u32(out + 16, y);
    wr_u32(out + 20, extent);
    wr_u32(out + 24, (uint32_t)t->cables.n);
    wr_u32(out + 28, (uint32_t)t->drops.n);
    wr_u32(out + 32, (uint32_t)t->taps.n);
    wr_u32(out + 36, (uint32_t)t->splices.n);
    size_t off = 40;

    for (int pass = 0; pass < 2; pass++) {
        const line_list_t *L = pass == 0 ? &t->cables : &t->drops;
        for (size_t i = 0; i < L->n; i++) {
            const line_feat_t *f = &L->v[i];
            wr_u16(out + off, f->n_pts);
            wr_u16(out + off + 2, f->size);
            wr_u32(out + off + 4, f->rgba);
            off += 8;
            for (uint16_t k = 0; k < f->n_pts; k++) {
                memcpy(out + off, &f->xy[k * 2], 4);
                memcpy(out + off + 4, &f->xy[k * 2 + 1], 4);
                off += 8;
            }
        }
    }
    for (size_t i = 0; i < t->taps.n; i++) {
        const tap_feat_t *tp = &t->taps.v[i];
        memcpy(out + off, &tp->x, 4);
        memcpy(out + off + 4, &tp->y, 4);
        out[off + 8] = tp->ports;
        out[off + 9] = out[off + 10] = out[off + 11] = 0;
        wr_u32(out + off + 12, tp->strand_rgba);
        wr_u32(out + off + 16, tp->tube_rgba);
        memcpy(out + off + 20, tp->sp_guid, 16);
        off += 36;
    }
    for (size_t i = 0; i < t->splices.n; i++) {
        const splice_feat_t *sp = &t->splices.v[i];
        /* 28 bytes: float x,y · rgba u32 · guid[16] */
        memcpy(out + off, &sp->x, 4);
        memcpy(out + off + 4, &sp->y, 4);
        wr_u32(out + off + 8, sp->rgba);
        memcpy(out + off + 12, sp->sp_guid, 16);
        off += 28;
    }
    return off;
}

static int mkdirs_p(const char *path)
{
    char tmp[1024];
    size_t len = strlen(path);
    if (len >= sizeof(tmp))
        return -1;
    memcpy(tmp, path, len + 1);
    for (size_t i = 1; i < len; i++) {
        if (tmp[i] == '/') {
            tmp[i] = '\0';
            if (mkdir(tmp, 0755) != 0 && errno != EEXIST)
                return -1;
            tmp[i] = '/';
        }
    }
    if (mkdir(tmp, 0755) != 0 && errno != EEXIST)
        return -1;
    return 0;
}

static int write_file(const char *path, const uint8_t *data, size_t len)
{
    FILE *f = fopen(path, "wb");
    if (!f) {
        fprintf(stderr, "write %s: %s\n", path, strerror(errno));
        return -1;
    }
    if (fwrite(data, 1, len, f) != len) {
        fclose(f);
        return -1;
    }
    fclose(f);
    return 0;
}

typedef struct {
    uint8_t z;
    uint32_t x, y;
} tile_id_t;

typedef struct {
    tile_id_t *ids;
    size_t n, cap;
    double min_lon, min_lat, max_lon, max_lat;
    int n_cables, n_drops, n_taps, n_splices;
} manifest_t;

static int manifest_add(manifest_t *m, uint8_t z, uint32_t x, uint32_t y)
{
    if (m->n >= m->cap) {
        size_t nc = m->cap ? m->cap * 2 : 256;
        tile_id_t *p = realloc(m->ids, nc * sizeof(*p));
        if (!p)
            return -1;
        m->ids = p;
        m->cap = nc;
    }
    m->ids[m->n++] = (tile_id_t){z, x, y};
    return 0;
}

static int write_tile(const char *outdir, uint8_t z, uint32_t x, uint32_t y,
                      uint32_t extent, const tile_t *t, bool quiet)
{
    if (t->cables.n == 0 && t->drops.n == 0 && t->taps.n == 0 &&
        t->splices.n == 0)
        return 0;
    size_t need = fmap_size_of(t);
    uint8_t *buf = malloc(need);
    if (!buf)
        return -1;
    size_t enc = fmap_encode(z, x, y, extent, t, buf, need);
    if (enc == 0) {
        free(buf);
        return -1;
    }
    char dir[768], path[800];
    snprintf(dir, sizeof(dir), "%s/%u/%u", outdir, z, x);
    if (mkdirs_p(dir) != 0) {
        free(buf);
        return -1;
    }
    snprintf(path, sizeof(path), "%s/%u.fmap", dir, y);
    if (write_file(path, buf, enc) != 0) {
        free(buf);
        return -1;
    }
    free(buf);
    if (!quiet)
        fprintf(stderr, "  wrote %s\n", path);
    return 1;
}

static int write_all_tiles(tile_map_t *tm, const char *outdir, manifest_t *man,
                           bool quiet)
{
    int written = 0;
    for (size_t i = 0; i < tm->nbuckets; i++) {
        for (tile_t *t = tm->buckets[i]; t; t = t->next) {
            int rc = write_tile(outdir, tm->z, t->x, t->y, tm->extent, t, quiet);
            if (rc < 0)
                return -1;
            if (rc > 0) {
                if (manifest_add(man, tm->z, t->x, t->y) != 0)
                    return -1;
                written++;
            }
        }
    }
    return written;
}

/* ── SQLite loaders ────────────────────────────────────────────────── */

static int table_exists(sqlite3 *db, const char *name)
{
    sqlite3_stmt *st = NULL;
    int ok = 0;
    if (sqlite3_prepare_v2(
            db, "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') "
                "AND name=?1",
            -1, &st, NULL) != SQLITE_OK)
        return 0;
    sqlite3_bind_text(st, 1, name, -1, SQLITE_STATIC);
    if (sqlite3_step(st) == SQLITE_ROW)
        ok = 1;
    sqlite3_finalize(st);
    return ok;
}

static int prepare_drop_cables(sqlite3 *db)
{
    char *err = NULL;
    sqlite3_exec(db, "DROP TABLE IF EXISTS _drop_cables;", NULL, NULL, NULL);
    /* Match fiber2wmap: drop ports only, one row per cable guid. */
    const char *sql =
        "CREATE TEMP TABLE _drop_cables AS\n"
        "SELECT p.patch_guid AS guid,\n"
        "  MIN(COALESCE(NULLIF(d.fiber_strand_color,''),\n"
        "               NULLIF(d.out_strand_color,''), 'Blue')) AS strand\n"
        "FROM ports p\n"
        "JOIN equipment e ON e.guid = p.parent_guid\n"
        "  AND p.parent_type = 'equipment'\n"
        "JOIN equipment_disp d ON d.guid = e.guid\n"
        "WHERE p.port_name_type = 'drop'\n"
        "  AND p.patch_guid IS NOT NULL\n"
        "  AND p.patch_guid != ''\n"
        "  AND p.patch_guid != '00000000-0000-0000-0000-000000000000'\n"
        "GROUP BY p.patch_guid;";
    if (sqlite3_exec(db, sql, NULL, NULL, &err) != SQLITE_OK) {
        fprintf(stderr, "drop cables: %s\n", err ? err : "?");
        sqlite3_free(err);
        return -1;
    }
    sqlite3_exec(db,
                 "CREATE INDEX IF NOT EXISTS _drop_cables_guid ON "
                 "_drop_cables(guid);",
                 NULL, NULL, NULL);
    return 0;
}

static int load_cables(sqlite3 *db, tile_map_t *tm, const ok_north_t *crs,
                       const struct options *opt, int *n_cables, int *n_drops)
{
    if (prepare_drop_cables(db) != 0)
        return -1;
    const char *sql =
        "SELECT c.geom, COALESCE(c.cable_size,0), dc.strand\n"
        "FROM cables c\n"
        "LEFT JOIN _drop_cables dc ON dc.guid = c.guid\n"
        "WHERE c.geom IS NOT NULL";
    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) != SQLITE_OK) {
        fprintf(stderr, "cables: %s\n", sqlite3_errmsg(db));
        return -1;
    }
    path_t path = {0};
    int nc = 0, nd = 0;
    while (sqlite3_step(st) == SQLITE_ROW) {
        if (opt->limit > 0 && (nc + nd) >= opt->limit)
            break;
        const uint8_t *blob = sqlite3_column_blob(st, 0);
        int blen = sqlite3_column_bytes(st, 0);
        int size = sqlite3_column_int(st, 1);
        const char *strand = (const char *)sqlite3_column_text(st, 2);
        int wlen = 0;
        const uint8_t *wkb = gpkg_to_wkb(blob, blen, &wlen);
        if (!wkb || wkb_decode_path(wkb, wlen, &path) != 0)
            continue;
        if (strand != NULL && opt->do_drops) {
            if (emit_path_lines(tm, crs, &path, (uint16_t)(size > 0 ? size : 1),
                                tia_color(strand), 1, opt) != 0) {
                path_free(&path);
                sqlite3_finalize(st);
                return -1;
            }
            nd++;
        } else if (opt->do_cables) {
            if (emit_path_lines(tm, crs, &path, (uint16_t)(size > 0 ? size : 1),
                                color_for_cable_size(size), 0, opt) != 0) {
                path_free(&path);
                sqlite3_finalize(st);
                return -1;
            }
            nc++;
        }
        if (!opt->quiet && ((nc + nd) % 5000) == 0 && (nc + nd) > 0)
            fprintf(stderr, "  cables %d + drops %d…\n", nc, nd);
    }
    path_free(&path);
    sqlite3_finalize(st);
    *n_cables = nc;
    *n_drops = nd;
    return 0;
}

static int load_taps(sqlite3 *db, tile_map_t *tm, const ok_north_t *crs,
                     const struct options *opt, int *count)
{
    if ((int)tm->z < opt->tap_zmin) {
        *count = 0;
        return 0;
    }
    const char *sql =
        "SELECT COALESCE(d.geom, s.geom),\n"
        "  COALESCE(NULLIF(e.tap_ports,0), NULLIF(d.tap_ports,0), 2),\n"
        "  COALESCE(NULLIF(d.fiber_tube_color,''), NULLIF(d.out_tube_color,''), "
        "'Blue'),\n"
        "  COALESCE(NULLIF(d.fiber_strand_color,''), "
        "NULLIF(d.out_strand_color,''), 'Blue'),\n"
        "  e.splicepoint_guid\n"
        "FROM equipment e\n"
        "JOIN equipment_disp d ON d.guid = e.guid\n"
        "LEFT JOIN splicepoints s ON s.guid = e.splicepoint_guid\n"
        "WHERE (e.is_tap = 1 OR e.tap_ports IN (2,4,8) OR d.tap_ports IN "
        "(2,4,8))\n"
        "  AND COALESCE(d.geom, s.geom) IS NOT NULL";
    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) != SQLITE_OK) {
        fprintf(stderr, "taps: %s\n", sqlite3_errmsg(db));
        return -1;
    }
    path_t path = {0};
    int n = 0;
    while (sqlite3_step(st) == SQLITE_ROW) {
        if (opt->limit > 0 && n >= opt->limit)
            break;
        const uint8_t *blob = sqlite3_column_blob(st, 0);
        int blen = sqlite3_column_bytes(st, 0);
        int ports = sqlite3_column_int(st, 1);
        const char *tube = (const char *)sqlite3_column_text(st, 2);
        const char *strand = (const char *)sqlite3_column_text(st, 3);
        const char *sp_guid = (const char *)sqlite3_column_text(st, 4);
        int wlen = 0;
        const uint8_t *wkb = gpkg_to_wkb(blob, blen, &wlen);
        if (!wkb || wkb_decode_path(wkb, wlen, &path) != 0 || path.n < 1)
            continue;
        double lon, lat;
        ok_north_inv(crs, path.xy[0], path.xy[1], &lon, &lat);
        uint8_t p = (uint8_t)(ports < 1 ? 1 : ports > 255 ? 255 : ports);
        uint8_t gbytes[16];
        memset(gbytes, 0, 16);
        if (sp_guid)
            parse_uuid_bytes(sp_guid, gbytes);
        if (emit_tap(tm, lon, lat, p, tia_color(strand), tia_color(tube), gbytes,
                     opt) != 0) {
            path_free(&path);
            sqlite3_finalize(st);
            return -1;
        }
        n++;
    }
    path_free(&path);
    sqlite3_finalize(st);
    *count = n;
    return 0;
}

/** Non-tap splicepoints (no tap equipment at the SP). */
static int load_splices(sqlite3 *db, tile_map_t *tm, const ok_north_t *crs,
                        const struct options *opt, int *count)
{
    if ((int)tm->z < opt->splice_zmin) {
        *count = 0;
        return 0;
    }
    const char *sql =
        "SELECT s.guid, s.geom\n"
        "FROM splicepoints s\n"
        "WHERE s.geom IS NOT NULL\n"
        "  AND s.guid NOT IN (\n"
        "    SELECT e.splicepoint_guid FROM equipment e\n"
        "    JOIN equipment_disp d ON d.guid = e.guid\n"
        "    WHERE e.splicepoint_guid IS NOT NULL\n"
        "      AND (e.is_tap = 1 OR e.tap_ports IN (2,4,8)\n"
        "           OR d.tap_ports IN (2,4,8))\n"
        "  )";
    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) != SQLITE_OK) {
        fprintf(stderr, "splices: %s\n", sqlite3_errmsg(db));
        return -1;
    }
    path_t path = {0};
    int n = 0;
    uint32_t col = color_splice_node();
    while (sqlite3_step(st) == SQLITE_ROW) {
        if (opt->limit > 0 && n >= opt->limit)
            break;
        const char *guid = (const char *)sqlite3_column_text(st, 0);
        const uint8_t *blob = sqlite3_column_blob(st, 1);
        int blen = sqlite3_column_bytes(st, 1);
        int wlen = 0;
        const uint8_t *wkb = gpkg_to_wkb(blob, blen, &wlen);
        if (!wkb || wkb_decode_path(wkb, wlen, &path) != 0 || path.n < 1)
            continue;
        double lon, lat;
        ok_north_inv(crs, path.xy[0], path.xy[1], &lon, &lat);
        uint8_t gbytes[16];
        memset(gbytes, 0, 16);
        if (guid)
            parse_uuid_bytes(guid, gbytes);
        if (emit_splice(tm, lon, lat, col, gbytes, opt) != 0) {
            path_free(&path);
            sqlite3_finalize(st);
            return -1;
        }
        n++;
        if (!opt->quiet && (n % 5000) == 0)
            fprintf(stderr, "  splices %d…\n", n);
    }
    path_free(&path);
    sqlite3_finalize(st);
    *count = n;
    return 0;
}

/* Global feature tables (written once, not per zoom) */
static int write_features_sqlite(sqlite3 *src, const ok_north_t *crs,
                                 const char *outdir, const struct options *opt)
{
    char path[768];
    snprintf(path, sizeof(path), "%s/features.sqlite", outdir);
    remove(path);
    sqlite3 *out = NULL;
    if (sqlite3_open(path, &out) != SQLITE_OK) {
        fprintf(stderr, "features.sqlite: %s\n", sqlite3_errmsg(out));
        return -1;
    }
    char *err = NULL;
    /* Single source of truth: tools/schema/schema_map.sql (embedded) */
    if (sqlite3_exec(out, webmap_schema_map_sql, NULL, NULL, &err) !=
        SQLITE_OK) {
        fprintf(stderr, "schema_map.sql: %s\n", err ? err : "?");
        sqlite3_free(err);
        sqlite3_close(out);
        return -1;
    }

    if (prepare_drop_cables(src) != 0) {
        sqlite3_close(out);
        return -1;
    }

    sqlite3_stmt *ins_c = NULL, *ins_t = NULL, *ins_s = NULL;
    sqlite3_prepare_v2(out,
                       "INSERT INTO map_cables(guid,is_drop,cable_size,"
                       "strand_color,rgba) VALUES(?,?,?,?,?)",
                       -1, &ins_c, NULL);
    sqlite3_prepare_v2(out,
                       "INSERT INTO map_taps(equip_guid,sp_guid,lon,lat,ports,"
                       "strand_color,tube_color,strand_rgba,tube_rgba,diagram) "
                       "VALUES(?,?,?,?,?,?,?,?,?,?)",
                       -1, &ins_t, NULL);
    sqlite3_prepare_v2(out,
                       "INSERT INTO map_splices(sp_guid,lon,lat,station_id,"
                       "rgba,diagram) VALUES(?,?,?,?,?,?)",
                       -1, &ins_s, NULL);

    sqlite3_exec(out, "BEGIN", NULL, NULL, NULL);

    /* cables */
    {
        const char *sql =
            "SELECT c.guid, c.geom, COALESCE(c.cable_size,0), dc.strand\n"
            "FROM cables c LEFT JOIN _drop_cables dc ON dc.guid=c.guid\n"
            "WHERE c.geom IS NOT NULL";
        sqlite3_stmt *st = NULL;
        sqlite3_prepare_v2(src, sql, -1, &st, NULL);
        path_t path = {0};
        int n = 0;
        while (sqlite3_step(st) == SQLITE_ROW) {
            if (opt->limit > 0 && n >= opt->limit)
                break;
            const char *guid = (const char *)sqlite3_column_text(st, 0);
            const uint8_t *blob = sqlite3_column_blob(st, 1);
            int blen = sqlite3_column_bytes(st, 1);
            int size = sqlite3_column_int(st, 2);
            const char *strand = (const char *)sqlite3_column_text(st, 3);
            int wlen = 0;
            const uint8_t *wkb = gpkg_to_wkb(blob, blen, &wlen);
            if (!wkb || wkb_decode_path(wkb, wlen, &path) != 0)
                continue;
            int is_drop = strand != NULL;
            uint32_t rgba =
                is_drop ? tia_color(strand) : color_for_cable_size(size);
            sqlite3_bind_text(ins_c, 1, guid, -1, SQLITE_TRANSIENT);
            sqlite3_bind_int(ins_c, 2, is_drop ? 1 : 0);
            sqlite3_bind_int(ins_c, 3, size);
            sqlite3_bind_text(ins_c, 4, strand ? strand : "", -1,
                              SQLITE_TRANSIENT);
            sqlite3_bind_int64(ins_c, 5, (sqlite3_int64)(uint32_t)rgba);
            sqlite3_step(ins_c);
            sqlite3_reset(ins_c);
            n++;
        }
        path_free(&path);
        sqlite3_finalize(st);
    }

    /* taps */
    {
        const char *sql =
            "SELECT e.guid, e.splicepoint_guid, s.station_id,\n"
            "  COALESCE(d.geom, s.geom),\n"
            "  COALESCE(NULLIF(e.tap_ports,0), NULLIF(d.tap_ports,0), 2),\n"
            "  COALESCE(NULLIF(d.fiber_tube_color,''), "
            "NULLIF(d.out_tube_color,''), 'Blue'),\n"
            "  COALESCE(NULLIF(d.fiber_strand_color,''), "
            "NULLIF(d.out_strand_color,''), 'Blue')\n"
            "FROM equipment e\n"
            "JOIN equipment_disp d ON d.guid = e.guid\n"
            "LEFT JOIN splicepoints s ON s.guid = e.splicepoint_guid\n"
            "WHERE (e.is_tap = 1 OR e.tap_ports IN (2,4,8) OR d.tap_ports IN "
            "(2,4,8))\n"
            "  AND COALESCE(d.geom, s.geom) IS NOT NULL";
        sqlite3_stmt *st = NULL;
        sqlite3_prepare_v2(src, sql, -1, &st, NULL);
        path_t path = {0};
        int n = 0;
        while (sqlite3_step(st) == SQLITE_ROW) {
            if (opt->limit > 0 && n >= opt->limit)
                break;
            const char *guid = (const char *)sqlite3_column_text(st, 0);
            const char *sp_guid = (const char *)sqlite3_column_text(st, 1);
            const char *station = (const char *)sqlite3_column_text(st, 2);
            const uint8_t *blob = sqlite3_column_blob(st, 3);
            int blen = sqlite3_column_bytes(st, 3);
            int ports = sqlite3_column_int(st, 4);
            const char *tube = (const char *)sqlite3_column_text(st, 5);
            const char *strand = (const char *)sqlite3_column_text(st, 6);
            int wlen = 0;
            const uint8_t *wkb = gpkg_to_wkb(blob, blen, &wlen);
            if (!wkb || wkb_decode_path(wkb, wlen, &path) != 0 || path.n < 1)
                continue;
            double lon, lat;
            ok_north_inv(crs, path.xy[0], path.xy[1], &lon, &lat);
            char diag[128];
            diagram_filename(station, sp_guid ? sp_guid : guid, diag,
                             sizeof(diag));
            sqlite3_bind_text(ins_t, 1, guid, -1, SQLITE_TRANSIENT);
            sqlite3_bind_text(ins_t, 2, sp_guid ? sp_guid : "", -1,
                              SQLITE_TRANSIENT);
            sqlite3_bind_double(ins_t, 3, lon);
            sqlite3_bind_double(ins_t, 4, lat);
            sqlite3_bind_int(ins_t, 5, ports);
            sqlite3_bind_text(ins_t, 6, strand ? strand : "Blue", -1,
                              SQLITE_TRANSIENT);
            sqlite3_bind_text(ins_t, 7, tube ? tube : "Blue", -1,
                              SQLITE_TRANSIENT);
            sqlite3_bind_int64(ins_t, 8, (sqlite3_int64)tia_color(strand));
            sqlite3_bind_int64(ins_t, 9, (sqlite3_int64)tia_color(tube));
            sqlite3_bind_text(ins_t, 10, diag, -1, SQLITE_TRANSIENT);
            sqlite3_step(ins_t);
            sqlite3_reset(ins_t);
            n++;
        }
        path_free(&path);
        sqlite3_finalize(st);
    }

    /* non-tap splicepoints */
    {
        const char *sql =
            "SELECT s.guid, s.station_id, s.geom\n"
            "FROM splicepoints s\n"
            "WHERE s.geom IS NOT NULL\n"
            "  AND s.guid NOT IN (\n"
            "    SELECT e.splicepoint_guid FROM equipment e\n"
            "    JOIN equipment_disp d ON d.guid = e.guid\n"
            "    WHERE e.splicepoint_guid IS NOT NULL\n"
            "      AND (e.is_tap = 1 OR e.tap_ports IN (2,4,8)\n"
            "           OR d.tap_ports IN (2,4,8))\n"
            "  )";
        sqlite3_stmt *st = NULL;
        sqlite3_prepare_v2(src, sql, -1, &st, NULL);
        path_t path = {0};
        int n = 0;
        uint32_t col = color_splice_node();
        while (sqlite3_step(st) == SQLITE_ROW) {
            if (opt->limit > 0 && n >= opt->limit)
                break;
            const char *guid = (const char *)sqlite3_column_text(st, 0);
            const char *station = (const char *)sqlite3_column_text(st, 1);
            const uint8_t *blob = sqlite3_column_blob(st, 2);
            int blen = sqlite3_column_bytes(st, 2);
            int wlen = 0;
            const uint8_t *wkb = gpkg_to_wkb(blob, blen, &wlen);
            if (!wkb || wkb_decode_path(wkb, wlen, &path) != 0 || path.n < 1)
                continue;
            double lon, lat;
            ok_north_inv(crs, path.xy[0], path.xy[1], &lon, &lat);
            char diag[128];
            diagram_filename(station, guid, diag, sizeof(diag));
            sqlite3_bind_text(ins_s, 1, guid, -1, SQLITE_TRANSIENT);
            sqlite3_bind_double(ins_s, 2, lon);
            sqlite3_bind_double(ins_s, 3, lat);
            sqlite3_bind_text(ins_s, 4, station ? station : "", -1,
                              SQLITE_TRANSIENT);
            sqlite3_bind_int64(ins_s, 5, (sqlite3_int64)col);
            sqlite3_bind_text(ins_s, 6, diag, -1, SQLITE_TRANSIENT);
            sqlite3_step(ins_s);
            sqlite3_reset(ins_s);
            n++;
        }
        path_free(&path);
        sqlite3_finalize(st);
    }

    sqlite3_exec(out, "COMMIT", NULL, NULL, NULL);
    sqlite3_finalize(ins_c);
    sqlite3_finalize(ins_t);
    sqlite3_finalize(ins_s);
    sqlite3_close(out);
    if (!opt->quiet)
        fprintf(stderr, "wrote %s (map_cables + map_taps + map_splices)\n",
                path);

    /* diagram_index.json: guid → HTML basename for all splicepoints */
    {
        char ipath[768];
        snprintf(ipath, sizeof(ipath), "%s/diagram_index.json", outdir);
        FILE *jf = fopen(ipath, "w");
        if (jf) {
            fprintf(jf, "{\n");
            const char *sql =
                "SELECT guid, station_id FROM splicepoints WHERE guid IS NOT NULL";
            sqlite3_stmt *st = NULL;
            if (sqlite3_prepare_v2(src, sql, -1, &st, NULL) == SQLITE_OK) {
                int first = 1;
                while (sqlite3_step(st) == SQLITE_ROW) {
                    const char *guid = (const char *)sqlite3_column_text(st, 0);
                    const char *station =
                        (const char *)sqlite3_column_text(st, 1);
                    if (!guid)
                        continue;
                    char diag[128];
                    diagram_filename(station, guid, diag, sizeof(diag));
                    /* escape minimal JSON */
                    fprintf(jf, "%s  \"%s\": \"%s\"", first ? "" : ",\n", guid,
                            diag);
                    first = 0;
                }
                sqlite3_finalize(st);
                fprintf(jf, "\n}\n");
            } else {
                fprintf(jf, "}\n");
            }
            fclose(jf);
            if (!opt->quiet)
                fprintf(stderr, "wrote %s\n", ipath);
        }
    }
    return 0;
}

static void scan_bbox(sqlite3 *db, const ok_north_t *crs, manifest_t *man)
{
    const char *sql = "SELECT geom FROM cables WHERE geom IS NOT NULL LIMIT 5000";
    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) != SQLITE_OK)
        return;
    path_t path = {0};
    while (sqlite3_step(st) == SQLITE_ROW) {
        const uint8_t *blob = sqlite3_column_blob(st, 0);
        int blen = sqlite3_column_bytes(st, 0), wlen = 0;
        const uint8_t *wkb = gpkg_to_wkb(blob, blen, &wlen);
        if (!wkb || wkb_decode_path(wkb, wlen, &path) != 0)
            continue;
        for (size_t i = 0; i < path.n; i++) {
            if (isnan(path.xy[i * 2]))
                continue;
            double lon, lat;
            ok_north_inv(crs, path.xy[i * 2], path.xy[i * 2 + 1], &lon, &lat);
            if (lon < man->min_lon)
                man->min_lon = lon;
            if (lon > man->max_lon)
                man->max_lon = lon;
            if (lat < man->min_lat)
                man->min_lat = lat;
            if (lat > man->max_lat)
                man->max_lat = lat;
        }
    }
    path_free(&path);
    sqlite3_finalize(st);
}

/** Basename of path for package source.label (no absolute paths in manifest). */
static const char *path_basename(const char *p)
{
    const char *base = p;
    if (!p)
        return "";
    for (const char *s = p; *s; s++) {
        if (*s == '/' || *s == '\\')
            base = s + 1;
    }
    return base;
}

static int write_manifest(const char *outdir, const manifest_t *man,
                          const struct options *opt)
{
    char path[768];
    snprintf(path, sizeof(path), "%s/manifest.json", outdir);
    FILE *f = fopen(path, "w");
    if (!f)
        return -1;
    double clon = (man->min_lon + man->max_lon) / 2.0;
    double clat = (man->min_lat + man->max_lat) / 2.0;
    if (man->min_lon > man->max_lon) {
        clon = -95.58;
        clat = 35.54;
    }
    const char *label = path_basename(opt->input);
    /* Package contract: docs/formats/data-packages.md (fiber) */
    fprintf(f,
            "{\n"
            "  \"kind\": \"fiber\",\n"
            "  \"format_version\": 1,\n"
            "  \"format\": \"fmap\",\n"
            "  \"fmap_version\": 2,\n"
            "  \"name\": \"%s\",\n"
            "  \"source\": {\n"
            "    \"adapter\": \"crescentlink_normalized_ecoec\",\n"
            "    \"label\": \"%s\"\n"
            "  },\n"
            "  \"crs_source\": \"EPSG:2267\",\n"
            "  \"bbox\": [%.6f, %.6f, %.6f, %.6f],\n"
            "  \"center\": [%.6f, %.6f],\n"
            "  \"zoom\": %d,\n"
            "  \"zmin\": %d,\n"
            "  \"zmax\": %d,\n"
            "  \"extent\": %u,\n"
            "  \"tap_zmin\": %d,\n"
            "  \"splice_zmin\": %d,\n"
            "  \"features\": {\"cables\": %d, \"drops\": %d, \"taps\": %d, "
            "\"splices\": %d},\n"
            "  \"tables\": [\"map_cables\", \"map_taps\", \"map_splices\"],\n"
            "  \"features_sqlite\": \"features.sqlite\",\n"
            "  \"diagram_index\": \"diagram_index.json\",\n"
            "  \"diagrams_url\": null,\n"
            "  \"tiles\": [\n",
            label, label, man->min_lon, man->min_lat, man->max_lon, man->max_lat,
            clon, clat, opt->zmin + (opt->zmax - opt->zmin) / 2, opt->zmin,
            opt->zmax, opt->extent, opt->tap_zmin, opt->splice_zmin,
            man->n_cables, man->n_drops, man->n_taps, man->n_splices);
    for (size_t i = 0; i < man->n; i++) {
        fprintf(f, "    {\"z\": %u, \"x\": %u, \"y\": %u}%s\n", man->ids[i].z,
                man->ids[i].x, man->ids[i].y, (i + 1 < man->n) ? "," : "");
    }
    fprintf(f, "  ]\n}\n");
    fclose(f);
    return 0;
}

static void usage(const char *argv0)
{
    fprintf(stderr,
            "Usage: %s [options] INPUT.sqlite -o OUT_DIR\n"
            "  Data-only fiber feature tiles (.fmap) + features.sqlite\n"
            "  --zmin/--zmax --tap-zmin --splice-zmin --limit N --bbox W,S,E,N -q\n",
            argv0);
}

int main(int argc, char **argv)
{
    struct options opt = {
        .zmin = 10,
        .zmax = 14,
        .tap_zmin = 13,
        .splice_zmin = 13,
        .extent = FMAP_EXTENT,
        .do_cables = true,
        .do_drops = true,
        .do_taps = true,
        .do_splices = true,
        .quiet = false,
        .limit = 0,
    };
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-h") || !strcmp(argv[i], "--help")) {
            usage(argv[0]);
            return 0;
        } else if (!strcmp(argv[i], "-o") && i + 1 < argc) {
            opt.outdir = argv[++i];
        } else if (!strcmp(argv[i], "--zmin") && i + 1 < argc) {
            opt.zmin = atoi(argv[++i]);
        } else if (!strcmp(argv[i], "--zmax") && i + 1 < argc) {
            opt.zmax = atoi(argv[++i]);
        } else if (!strcmp(argv[i], "--tap-zmin") && i + 1 < argc) {
            opt.tap_zmin = atoi(argv[++i]);
        } else if (!strcmp(argv[i], "--splice-zmin") && i + 1 < argc) {
            opt.splice_zmin = atoi(argv[++i]);
        } else if (!strcmp(argv[i], "--limit") && i + 1 < argc) {
            opt.limit = atoi(argv[++i]);
        } else if (!strcmp(argv[i], "--extent") && i + 1 < argc) {
            opt.extent = (uint32_t)atoi(argv[++i]);
        } else if (!strcmp(argv[i], "--bbox") && i + 1 < argc) {
            if (sscanf(argv[++i], "%lf,%lf,%lf,%lf", &opt.bbox_w, &opt.bbox_s,
                       &opt.bbox_e, &opt.bbox_n) != 4) {
                fprintf(stderr, "bad --bbox\n");
                return 1;
            }
            opt.have_bbox = true;
        } else if (!strcmp(argv[i], "-q") || !strcmp(argv[i], "--quiet")) {
            opt.quiet = true;
        } else if (argv[i][0] == '-') {
            fprintf(stderr, "unknown %s\n", argv[i]);
            return 1;
        } else if (!opt.input) {
            opt.input = argv[i];
        } else {
            fprintf(stderr, "unexpected %s\n", argv[i]);
            return 1;
        }
    }
    if (!opt.input || !opt.outdir) {
        usage(argv[0]);
        return 1;
    }
    if (mkdirs_p(opt.outdir) != 0) {
        fprintf(stderr, "mkdir %s: %s\n", opt.outdir, strerror(errno));
        return 1;
    }

    sqlite3 *db = NULL;
    if (sqlite3_open_v2(opt.input, &db, SQLITE_OPEN_READONLY, NULL) !=
        SQLITE_OK) {
        fprintf(stderr, "open %s: %s\n", opt.input, sqlite3_errmsg(db));
        sqlite3_close(db);
        return 1;
    }
    if (!table_exists(db, "cables")) {
        fprintf(stderr, "input lacks cables table (need fiber_design.sqlite)\n");
        sqlite3_close(db);
        return 1;
    }

    ok_north_t crs;
    ok_north_init(&crs);

    manifest_t man = {0};
    man.min_lon = 1e9;
    man.min_lat = 1e9;
    man.max_lon = -1e9;
    man.max_lat = -1e9;
    scan_bbox(db, &crs, &man);
    if (opt.have_bbox) {
        man.min_lon = opt.bbox_w;
        man.min_lat = opt.bbox_s;
        man.max_lon = opt.bbox_e;
        man.max_lat = opt.bbox_n;
    }

    if (!opt.quiet)
        fprintf(stderr, "fiber2features: %s → %s  z%d–%d  tap≥%d\n", opt.input,
                opt.outdir, opt.zmin, opt.zmax, opt.tap_zmin);

    /* Global tables once */
    if (write_features_sqlite(db, &crs, opt.outdir, &opt) != 0) {
        sqlite3_close(db);
        return 1;
    }

    clock_t t0 = clock();
    for (int z = opt.zmin; z <= opt.zmax; z++) {
        tile_map_t tm;
        if (tile_map_init(&tm, (uint8_t)z, opt.extent) != 0) {
            sqlite3_close(db);
            return 1;
        }
        if (!opt.quiet)
            fprintf(stderr, "zoom %d:\n", z);
        int nc = 0, nd = 0, nt = 0;
        if (load_cables(db, &tm, &crs, &opt, &nc, &nd) != 0) {
            tile_map_free(&tm);
            sqlite3_close(db);
            return 1;
        }
        if (opt.do_taps && load_taps(db, &tm, &crs, &opt, &nt) != 0) {
            tile_map_free(&tm);
            sqlite3_close(db);
            return 1;
        }
        int ns = 0;
        if (opt.do_splices && load_splices(db, &tm, &crs, &opt, &ns) != 0) {
            tile_map_free(&tm);
            sqlite3_close(db);
            return 1;
        }
        man.n_cables = nc;
        man.n_drops = nd;
        man.n_taps = nt;
        man.n_splices = ns;
        int nw = write_all_tiles(&tm, opt.outdir, &man, opt.quiet);
        if (nw < 0) {
            tile_map_free(&tm);
            free(man.ids);
            sqlite3_close(db);
            return 1;
        }
        if (!opt.quiet)
            fprintf(stderr,
                    "  z%d: %d cables, %d drops, %d taps, %d splices → %d tiles\n",
                    z, nc, nd, nt, ns, nw);
        tile_map_free(&tm);
    }

    if (write_manifest(opt.outdir, &man, &opt) != 0) {
        free(man.ids);
        sqlite3_close(db);
        return 1;
    }
    double sec = (double)(clock() - t0) / (double)CLOCKS_PER_SEC;
    if (!opt.quiet)
        fprintf(stderr, "done: %zu tiles in %.1fs → %s\n", man.n, sec,
                opt.outdir);
    free(man.ids);
    sqlite3_close(db);
    return 0;
}
