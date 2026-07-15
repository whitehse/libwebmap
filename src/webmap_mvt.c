/**
 * @file webmap_mvt.c
 * @brief Minimal Mapbox Vector Tile (protobuf) decoder + tessellation.
 *
 * Implements enough of the MVT / protobuf wire format to convert
 * GeoFabrik experimental .pbf tiles into GPU-ready polylines and points.
 * Polygon rings are stored as line loops (fill triangulation deferred).
 */

#include "webmap_mvt.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Protobuf wire helpers ─────────────────────────────────────────── */

static int pb_read_varint(const uint8_t **pp, const uint8_t *end, uint64_t *out)
{
    uint64_t result = 0;
    int shift = 0;
    const uint8_t *p = *pp;
    while (p < end && shift < 64) {
        uint8_t b = *p++;
        result |= (uint64_t)(b & 0x7F) << shift;
        if ((b & 0x80) == 0) {
            *pp = p;
            *out = result;
            return 0;
        }
        shift += 7;
    }
    return -1;
}

static int pb_skip(const uint8_t **pp, const uint8_t *end, int wire)
{
    uint64_t v;
    const uint8_t *p = *pp;
    switch (wire) {
    case 0: /* varint */
        return pb_read_varint(pp, end, &v);
    case 1: /* 64-bit */
        if (p + 8 > end) {
            return -1;
        }
        *pp = p + 8;
        return 0;
    case 2: /* len-delimited */
        if (pb_read_varint(pp, end, &v) != 0) {
            return -1;
        }
        p = *pp;
        if (p + v > end) {
            return -1;
        }
        *pp = p + (size_t)v;
        return 0;
    case 5: /* 32-bit */
        if (p + 4 > end) {
            return -1;
        }
        *pp = p + 4;
        return 0;
    default:
        return -1;
    }
}

static int32_t zig_zag_decode(uint32_t n)
{
    return (int32_t)((n >> 1) ^ (-(int32_t)(n & 1)));
}

/* ── Layer builders ────────────────────────────────────────────────── */

static int layer_ensure_verts(webmap_mvt_layer_t *L, size_t need)
{
    webmap_vertex_t *p;
    size_t cap = L->vertex_cap;
    if (need <= cap) {
        return 0;
    }
    if (cap == 0) {
        cap = 64;
    }
    while (cap < need) {
        cap *= 2;
    }
    p = realloc(L->vertices, cap * sizeof(*p));
    if (!p) {
        return -1;
    }
    L->vertices = p;
    L->vertex_cap = cap;
    return 0;
}

static int layer_ensure_inds(webmap_mvt_layer_t *L, size_t need)
{
    uint32_t *p;
    size_t cap = L->index_cap;
    if (need <= cap) {
        return 0;
    }
    if (cap == 0) {
        cap = 64;
    }
    while (cap < need) {
        cap *= 2;
    }
    p = realloc(L->indices, cap * sizeof(*p));
    if (!p) {
        return -1;
    }
    L->indices = p;
    L->index_cap = cap;
    return 0;
}

static int tile_push_layer(webmap_mvt_tile_t *t, webmap_mvt_layer_t *L)
{
    webmap_mvt_layer_t *p;
    if (t->layer_count + 1 > t->layer_cap) {
        size_t cap = t->layer_cap ? t->layer_cap * 2 : 8;
        p = realloc(t->layers, cap * sizeof(*p));
        if (!p) {
            return -1;
        }
        t->layers = p;
        t->layer_cap = cap;
    }
    t->layers[t->layer_count++] = *L;
    memset(L, 0, sizeof(*L));
    return 0;
}

webmap_feature_class_t webmap_mvt_layer_class(const char *name)
{
    if (!name) {
        return WEBMAP_CLASS_BASEMAP;
    }
    if (strstr(name, "power") || strstr(name, "electric")) {
        return WEBMAP_CLASS_POWER_LINE;
    }
    if (strstr(name, "telecom") || strstr(name, "fibre") ||
        strstr(name, "fiber") || strstr(name, "communication")) {
        return WEBMAP_CLASS_FIBER_SPAN;
    }
    return WEBMAP_CLASS_BASEMAP;
}

uint32_t webmap_mvt_layer_rgba(const char *name)
{
    if (!name) {
        return 0xFFD8D2C8u; /* neutral land */
    }
    /*
     * Shortbread-inspired palette (VersaTiles Neutrino / MapLibre light).
     * Packed as 0xAABBGGRR (little-endian RGBA bytes in .wmap / WebGPU).
     */
    if (strcmp(name, "water") == 0 || strcmp(name, "water_polygons") == 0 ||
        strcmp(name, "ocean") == 0) {
        return 0xFFDFD3AAu; /* #aad3df water fill */
    }
    if (strcmp(name, "waterway") == 0 || strcmp(name, "water_lines") == 0) {
        return 0xFFF0C8A0u; /* #a0c8f0 rivers / streams */
    }
    if (strcmp(name, "land") == 0) {
        return 0xFFE9EFF2u; /* #f2efe9 cream land */
    }
    if (strcmp(name, "landcover") == 0 || strcmp(name, "landuse") == 0 ||
        strcmp(name, "park") == 0) {
        return 0xFFC8F2C4u; /* #c4f2c8 parks / green */
    }
    if (strcmp(name, "building") == 0 || strcmp(name, "buildings") == 0) {
        return 0xFFC6D3DEu; /* #ded3c6 buildings */
    }
    if (strcmp(name, "transportation") == 0 || strcmp(name, "road") == 0 ||
        strcmp(name, "highway") == 0 || strcmp(name, "streets") == 0 ||
        strcmp(name, "street_polygons") == 0) {
        return 0xFFFFFFFFu; /* white road fill */
    }
    if (strcmp(name, "transportation_name") == 0 ||
        strcmp(name, "street_labels") == 0) {
        return 0xFF6B655Cu; /* muted label ink (if drawn) */
    }
    if (strcmp(name, "boundary") == 0 || strcmp(name, "boundaries") == 0) {
        return 0xFFB8AFA4u;
    }
    if (strcmp(name, "pois") == 0 || strcmp(name, "sites") == 0 ||
        strcmp(name, "public_transport") == 0) {
        return 0xFF5A9FD4u;
    }
    if (strstr(name, "power") || strstr(name, "electric")) {
        return 0xFFE67E22u;
    }
    if (strstr(name, "fiber") || strstr(name, "fibre") ||
        strstr(name, "telecom")) {
        return 0xFF9B59B6u;
    }
    return 0xFFD8D2C8u;
}

/* ── Ear-clip triangulation (simple polygons, no holes) ────────────── */

static float cross2(float ax, float ay, float bx, float by, float cx, float cy)
{
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

static int point_in_tri(float px, float py, float ax, float ay, float bx,
                        float by, float cx, float cy)
{
    float c1 = cross2(ax, ay, bx, by, px, py);
    float c2 = cross2(bx, by, cx, cy, px, py);
    float c3 = cross2(cx, cy, ax, ay, px, py);
    int has_neg = (c1 < 0) || (c2 < 0) || (c3 < 0);
    int has_pos = (c1 > 0) || (c2 > 0) || (c3 > 0);
    return !(has_neg && has_pos);
}

/**
 * Ear-clip ring vertices [base, base+n). Appends triangle indices into L.
 * MVT exterior rings are typically clockwise in tile coords (y-down).
 */
static int earclip_ring(webmap_mvt_layer_t *L, size_t base, size_t n)
{
    size_t *idx;
    size_t remaining;
    size_t guard;
    size_t i;

    if (n < 3) {
        return 0;
    }
    /* Drop duplicate closing vertex if present. */
    if (L->vertices[base].x == L->vertices[base + n - 1].x &&
        L->vertices[base].y == L->vertices[base + n - 1].y) {
        n--;
    }
    if (n < 3) {
        return 0;
    }
    if (n > 4096) {
        /* Cap pathological rings; outline already optional */
        n = 4096;
    }

    idx = malloc(n * sizeof(size_t));
    if (!idx) {
        return -1;
    }
    for (i = 0; i < n; i++) {
        idx[i] = base + i;
    }
    remaining = n;
    guard = 0;

    while (remaining > 3 && guard < n * n) {
        int ear_found = 0;
        guard++;
        for (i = 0; i < remaining; i++) {
            size_t i0 = idx[(i + remaining - 1) % remaining];
            size_t i1 = idx[i];
            size_t i2 = idx[(i + 1) % remaining];
            float ax = L->vertices[i0].x, ay = L->vertices[i0].y;
            float bx = L->vertices[i1].x, by = L->vertices[i1].y;
            float cx = L->vertices[i2].x, cy = L->vertices[i2].y;
            float cr = cross2(ax, ay, bx, by, cx, cy);
            size_t j;
            int empty = 1;

            /* MVT y-down: exterior often clockwise → cross <= 0 is convex ear */
            if (cr > 0.0f) {
                continue; /* reflex for CW polygon */
            }
            for (j = 0; j < remaining; j++) {
                size_t pi;
                if (j == (i + remaining - 1) % remaining || j == i ||
                    j == (i + 1) % remaining) {
                    continue;
                }
                pi = idx[j];
                if (point_in_tri(L->vertices[pi].x, L->vertices[pi].y, ax, ay,
                                 bx, by, cx, cy)) {
                    empty = 0;
                    break;
                }
            }
            if (!empty) {
                continue;
            }
            if (layer_ensure_inds(L, L->index_count + 3) != 0) {
                free(idx);
                return -1;
            }
            L->indices[L->index_count++] = (uint32_t)i0;
            L->indices[L->index_count++] = (uint32_t)i1;
            L->indices[L->index_count++] = (uint32_t)i2;
            /* remove ear vertex i */
            {
                size_t k;
                for (k = i; k + 1 < remaining; k++) {
                    idx[k] = idx[k + 1];
                }
            }
            remaining--;
            ear_found = 1;
            break;
        }
        if (!ear_found) {
            /* Fallback fan from first vertex (handles some self-intersections) */
            for (i = 1; i + 1 < remaining; i++) {
                if (layer_ensure_inds(L, L->index_count + 3) != 0) {
                    free(idx);
                    return -1;
                }
                L->indices[L->index_count++] = (uint32_t)idx[0];
                L->indices[L->index_count++] = (uint32_t)idx[i];
                L->indices[L->index_count++] = (uint32_t)idx[i + 1];
            }
            free(idx);
            return 0;
        }
    }
    if (remaining == 3) {
        if (layer_ensure_inds(L, L->index_count + 3) != 0) {
            free(idx);
            return -1;
        }
        L->indices[L->index_count++] = (uint32_t)idx[0];
        L->indices[L->index_count++] = (uint32_t)idx[1];
        L->indices[L->index_count++] = (uint32_t)idx[2];
    }
    free(idx);
    return 0;
}

/* ── Geometry commands (MVT) ───────────────────────────────────────── */

static int decode_geometry(const uint8_t *data, size_t len,
                           webmap_mvt_layer_t *L, uint32_t rgba)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;
    int32_t cx = 0, cy = 0;
    size_t ring_start = 0;
    int is_poly = (L->geom_type == WEBMAP_MVT_POLYGON);
    int is_line = (L->geom_type == WEBMAP_MVT_LINE ||
                   L->geom_type == WEBMAP_MVT_UNKNOWN);
    int is_point = (L->geom_type == WEBMAP_MVT_POINT);

    while (p < end) {
        uint64_t cmd_int;
        uint32_t cmd, count, k;
        if (pb_read_varint(&p, end, &cmd_int) != 0) {
            return -1;
        }
        cmd = (uint32_t)cmd_int & 0x7u;
        count = (uint32_t)cmd_int >> 3;

        if (cmd == 1) { /* MoveTo */
            for (k = 0; k < count; k++) {
                uint64_t dx, dy;
                if (pb_read_varint(&p, end, &dx) != 0 ||
                    pb_read_varint(&p, end, &dy) != 0) {
                    return -1;
                }
                cx += zig_zag_decode((uint32_t)dx);
                cy += zig_zag_decode((uint32_t)dy);
                if (layer_ensure_verts(L, L->vertex_count + 1) != 0) {
                    return -1;
                }
                ring_start = L->vertex_count;
                L->vertices[L->vertex_count].x = (float)cx;
                L->vertices[L->vertex_count].y = (float)cy;
                L->vertices[L->vertex_count].rgba = rgba;
                L->vertex_count++;

                if (is_point) {
                    if (layer_ensure_inds(L, L->index_count + 1) != 0) {
                        return -1;
                    }
                    L->indices[L->index_count++] =
                        (uint32_t)(L->vertex_count - 1);
                }
            }
        } else if (cmd == 2) { /* LineTo */
            for (k = 0; k < count; k++) {
                uint64_t dx, dy;
                uint32_t prev;
                if (pb_read_varint(&p, end, &dx) != 0 ||
                    pb_read_varint(&p, end, &dy) != 0) {
                    return -1;
                }
                cx += zig_zag_decode((uint32_t)dx);
                cy += zig_zag_decode((uint32_t)dy);
                if (layer_ensure_verts(L, L->vertex_count + 1) != 0) {
                    return -1;
                }
                prev = (uint32_t)(L->vertex_count - 1);
                L->vertices[L->vertex_count].x = (float)cx;
                L->vertices[L->vertex_count].y = (float)cy;
                L->vertices[L->vertex_count].rgba = rgba;
                L->vertex_count++;
                if (is_line) {
                    if (layer_ensure_inds(L, L->index_count + 2) != 0) {
                        return -1;
                    }
                    L->indices[L->index_count++] = prev;
                    L->indices[L->index_count++] =
                        (uint32_t)(L->vertex_count - 1);
                }
                /* polygons: vertices only until ClosePath ear-clip */
            }
        } else if (cmd == 7) { /* ClosePath */
            size_t n = L->vertex_count - ring_start;
            if (is_poly && n >= 3) {
                if (earclip_ring(L, ring_start, n) != 0) {
                    return -1;
                }
            } else if (is_line && n > 1) {
                if (layer_ensure_inds(L, L->index_count + 2) != 0) {
                    return -1;
                }
                L->indices[L->index_count++] =
                    (uint32_t)(L->vertex_count - 1);
                L->indices[L->index_count++] = (uint32_t)ring_start;
            }
        } else {
            return -1;
        }
    }
    return 0;
}

/* ── Feature / Layer message ───────────────────────────────────────── */

static int parse_feature(const uint8_t *data, size_t len, webmap_mvt_layer_t *L,
                         uint32_t rgba)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;
    const uint8_t *geom = NULL;
    size_t geom_len = 0;
    uint64_t gtype = 0;

    while (p < end) {
        uint64_t key, v;
        int field, wire;
        if (pb_read_varint(&p, end, &key) != 0) {
            return -1;
        }
        field = (int)(key >> 3);
        wire = (int)(key & 7);
        if (field == 3 && wire == 0) { /* type */
            if (pb_read_varint(&p, end, &gtype) != 0) {
                return -1;
            }
        } else if (field == 4 && wire == 2) { /* geometry */
            if (pb_read_varint(&p, end, &v) != 0) {
                return -1;
            }
            geom = p;
            geom_len = (size_t)v;
            p += geom_len;
            if (p > end) {
                return -1;
            }
        } else {
            if (pb_skip(&p, end, wire) != 0) {
                return -1;
            }
        }
    }

    if (gtype == 1) {
        L->geom_type = WEBMAP_MVT_POINT;
    } else if (gtype == 2) {
        L->geom_type = WEBMAP_MVT_LINE;
    } else if (gtype == 3) {
        L->geom_type = WEBMAP_MVT_POLYGON;
    }

    if (geom && geom_len) {
        return decode_geometry(geom, geom_len, L, rgba);
    }
    return 0;
}

static int parse_layer(const uint8_t *data, size_t len, webmap_mvt_tile_t *tile)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;
    webmap_mvt_layer_t L;
    uint32_t rgba;
    uint64_t extent = WEBMAP_DEFAULT_EXTENT;

    memset(&L, 0, sizeof(L));
    snprintf(L.name, sizeof(L.name), "layer");
    L.extent = WEBMAP_DEFAULT_EXTENT;

    /* First pass: name + extent */
    p = data;
    while (p < end) {
        uint64_t key, v;
        int field, wire;
        if (pb_read_varint(&p, end, &key) != 0) {
            return -1;
        }
        field = (int)(key >> 3);
        wire = (int)(key & 7);
        if (field == 1 && wire == 2) { /* name */
            if (pb_read_varint(&p, end, &v) != 0) {
                return -1;
            }
            if (p + v > end) {
                return -1;
            }
            {
                size_t n = (size_t)v;
                if (n >= sizeof(L.name)) {
                    n = sizeof(L.name) - 1;
                }
                memcpy(L.name, p, n);
                L.name[n] = '\0';
            }
            p += (size_t)v;
        } else if (field == 5 && wire == 0) { /* extent */
            if (pb_read_varint(&p, end, &extent) != 0) {
                return -1;
            }
            L.extent = (uint32_t)extent;
        } else {
            if (pb_skip(&p, end, wire) != 0) {
                return -1;
            }
        }
    }

    rgba = webmap_mvt_layer_rgba(L.name);

    /* Second pass: features */
    p = data;
    while (p < end) {
        uint64_t key, v;
        int field, wire;
        if (pb_read_varint(&p, end, &key) != 0) {
            return -1;
        }
        field = (int)(key >> 3);
        wire = (int)(key & 7);
        if (field == 2 && wire == 2) { /* feature */
            if (pb_read_varint(&p, end, &v) != 0) {
                return -1;
            }
            if (p + v > end) {
                return -1;
            }
            if (parse_feature(p, (size_t)v, &L, rgba) != 0) {
                /* tolerate bad feature */
            }
            p += (size_t)v;
        } else {
            if (pb_skip(&p, end, wire) != 0) {
                webmap_mvt_tile_free(tile);
                free(L.vertices);
                free(L.indices);
                return -1;
            }
        }
    }

    if (L.vertex_count == 0) {
        free(L.vertices);
        free(L.indices);
        return 0;
    }

    if (tile_push_layer(tile, &L) != 0) {
        free(L.vertices);
        free(L.indices);
        return -1;
    }
    return 0;
}

int webmap_mvt_decode(const uint8_t *data, size_t len, webmap_mvt_tile_t *out)
{
    const uint8_t *p;
    const uint8_t *end;

    if (!data || !out) {
        return -1;
    }
    memset(out, 0, sizeof(*out));
    p = data;
    end = data + len;

    while (p < end) {
        uint64_t key, v;
        int field, wire;
        if (pb_read_varint(&p, end, &key) != 0) {
            webmap_mvt_tile_free(out);
            return -1;
        }
        field = (int)(key >> 3);
        wire = (int)(key & 7);
        if (field == 3 && wire == 2) { /* Tile.layers */
            if (pb_read_varint(&p, end, &v) != 0) {
                webmap_mvt_tile_free(out);
                return -1;
            }
            if (p + v > end) {
                webmap_mvt_tile_free(out);
                return -1;
            }
            if (parse_layer(p, (size_t)v, out) != 0) {
                webmap_mvt_tile_free(out);
                return -1;
            }
            p += (size_t)v;
        } else {
            if (pb_skip(&p, end, wire) != 0) {
                webmap_mvt_tile_free(out);
                return -1;
            }
        }
    }
    return 0;
}

void webmap_mvt_tile_free(webmap_mvt_tile_t *tile)
{
    size_t i;
    if (!tile) {
        return;
    }
    for (i = 0; i < tile->layer_count; i++) {
        free(tile->layers[i].vertices);
        free(tile->layers[i].indices);
    }
    free(tile->layers);
    memset(tile, 0, sizeof(*tile));
}
