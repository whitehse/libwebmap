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
    char base[64];
    const char *slash;

    if (!name) {
        return WEBMAP_CLASS_BASEMAP;
    }
    slash = strchr(name, '/');
    if (slash) {
        size_t n = (size_t)(slash - name);
        if (n >= sizeof(base)) {
            n = sizeof(base) - 1;
        }
        memcpy(base, name, n);
        base[n] = '\0';
        name = base;
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

/* Pack #RRGGBB (or #RRGGBBAA) into little-endian 0xAABBGGRR. */
static uint32_t pack_rgb(unsigned r, unsigned g, unsigned b, unsigned a)
{
    return ((uint32_t)(a & 0xFFu) << 24) | ((uint32_t)(b & 0xFFu) << 16) |
           ((uint32_t)(g & 0xFFu) << 8) | (uint32_t)(r & 0xFFu);
}

static uint32_t pack_hex6(unsigned rgb)
{
    return pack_rgb((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF, 0xFF);
}

/*
 * VersaTiles Colorful defaults (shortbread-tiles / versatiles-style), adapted
 * for Shortbread layer+kind. See https://shortbread-tiles.org/schema/1.0/
 */
uint32_t webmap_mvt_feature_rgba(const char *layer, const char *kind)
{
    char base_buf[64];
    char kind_buf[64];
    const char *base = layer ? layer : "";
    const char *k = kind ? kind : "";

    /* Strip optional "layer/kind" composite names produced by the decoder. */
    {
        const char *slash = strchr(base, '/');
        if (slash && slash[1] && (!kind || !kind[0])) {
            size_t n = (size_t)(slash - base);
            if (n >= sizeof(base_buf)) {
                n = sizeof(base_buf) - 1;
            }
            memcpy(base_buf, base, n);
            base_buf[n] = '\0';
            snprintf(kind_buf, sizeof(kind_buf), "%s", slash + 1);
            base = base_buf;
            k = kind_buf;
        }
    }

    /* ── Water ─────────────────────────────────────────────────────── */
    if (strcmp(base, "ocean") == 0 || strcmp(base, "water") == 0 ||
        strcmp(base, "water_polygons") == 0) {
        if (strcmp(k, "glacier") == 0) {
            return pack_hex6(0xFFFFFF);
        }
        return pack_hex6(0xBEDDF3); /* colorful.water */
    }
    if (strcmp(base, "water_lines") == 0 || strcmp(base, "waterway") == 0) {
        if (strcmp(k, "stream") == 0 || strcmp(k, "ditch") == 0) {
            return pack_hex6(0xA8D4F0);
        }
        return pack_hex6(0x9CCBEA); /* rivers / canals slightly deeper */
    }
    if (strcmp(base, "dam_lines") == 0 || strcmp(base, "dam_polygons") == 0 ||
        strcmp(base, "pier_lines") == 0 || strcmp(base, "pier_polygons") == 0) {
        return pack_hex6(0xF9F4EE); /* land-like piers/dams */
    }

    /* ── Land cover / use (Shortbread "land") ──────────────────────── */
    if (strcmp(base, "land") == 0 || strcmp(base, "landcover") == 0 ||
        strcmp(base, "landuse") == 0) {
        if (strcmp(k, "forest") == 0 || strcmp(k, "wood") == 0) {
            return pack_hex6(0x66AA44);
        }
        if (strcmp(k, "grass") == 0 || strcmp(k, "grassland") == 0 ||
            strcmp(k, "meadow") == 0 || strcmp(k, "village_green") == 0 ||
            strcmp(k, "recreation_ground") == 0 || strcmp(k, "heath") == 0 ||
            strcmp(k, "scrub") == 0) {
            return pack_hex6(0xD8E8C8);
        }
        if (strcmp(k, "park") == 0 || strcmp(k, "golf_course") == 0) {
            return pack_hex6(0xD9D9A5);
        }
        if (strcmp(k, "orchard") == 0 || strcmp(k, "vineyard") == 0 ||
            strcmp(k, "farmland") == 0 || strcmp(k, "farmyard") == 0 ||
            strcmp(k, "allotments") == 0 ||
            strcmp(k, "greenhouse_horticulture") == 0 ||
            strcmp(k, "plant_nursery") == 0 || strcmp(k, "greenfield") == 0) {
            return pack_hex6(0xF0E7D1);
        }
        if (strcmp(k, "residential") == 0) {
            return pack_rgb(0xEA, 0xE6, 0xE1, 0x55); /* #EAE6E1 ~33% */
        }
        if (strcmp(k, "commercial") == 0 || strcmp(k, "retail") == 0) {
            return pack_rgb(0xF7, 0xDE, 0xED, 0x50);
        }
        if (strcmp(k, "industrial") == 0 || strcmp(k, "railway") == 0 ||
            strcmp(k, "brownfield") == 0) {
            return pack_rgb(0xFF, 0xF4, 0xC2, 0x60);
        }
        if (strcmp(k, "landfill") == 0 || strcmp(k, "waste") == 0) {
            return pack_hex6(0xDBD6BD);
        }
        if (strcmp(k, "cemetery") == 0 || strcmp(k, "grave_yard") == 0) {
            return pack_hex6(0xDDDBCA);
        }
        if (strcmp(k, "sand") == 0 || strcmp(k, "beach") == 0) {
            return pack_hex6(0xFAFAED);
        }
        if (strcmp(k, "bare_rock") == 0 || strcmp(k, "scree") == 0 ||
            strcmp(k, "shingle") == 0) {
            return pack_hex6(0xE0E4E5);
        }
        if (strcmp(k, "swamp") == 0 || strcmp(k, "bog") == 0 ||
            strcmp(k, "string_bog") == 0 || strcmp(k, "wet_meadow") == 0 ||
            strcmp(k, "wetland") == 0 || strcmp(k, "marsh") == 0) {
            return pack_hex6(0xD3E6DB);
        }
        /* bare land polygons still need a soft fill vs. background */
        return pack_hex6(0xF4EFE6);
    }

    /* ── Sites / buildings ─────────────────────────────────────────── */
    if (strcmp(base, "sites") == 0) {
        if (strcmp(k, "hospital") == 0 || strcmp(k, "clinic") == 0) {
            return pack_hex6(0xFFDADA);
        }
        if (strcmp(k, "school") == 0 || strcmp(k, "college") == 0 ||
            strcmp(k, "university") == 0 || strcmp(k, "kindergarten") == 0) {
            return pack_hex6(0xF0EAD8);
        }
        if (strcmp(k, "parking") == 0) {
            return pack_hex6(0xEEEEEE);
        }
        return pack_rgb(0xE7, 0xED, 0xDE, 0xA0);
    }
    if (strcmp(base, "building") == 0 || strcmp(base, "buildings") == 0) {
        return pack_hex6(0xF2EAE2);
    }
    if (strcmp(base, "bridges") == 0 || strcmp(base, "bridge") == 0) {
        return pack_rgb(0xF9, 0xF4, 0xEE, 0xCC);
    }

    /* ── Streets / transport (Shortbread "streets") ────────────────── */
    if (strcmp(base, "streets") == 0 || strcmp(base, "street_polygons") == 0 ||
        strcmp(base, "transportation") == 0 || strcmp(base, "road") == 0 ||
        strcmp(base, "highway") == 0) {
        if (strcmp(k, "motorway") == 0 || strcmp(k, "motorway_link") == 0) {
            return pack_hex6(0xFFCC88);
        }
        if (strcmp(k, "trunk") == 0 || strcmp(k, "trunk_link") == 0 ||
            strcmp(k, "primary") == 0 || strcmp(k, "primary_link") == 0 ||
            strcmp(k, "secondary") == 0 || strcmp(k, "secondary_link") == 0) {
            return pack_hex6(0xFFEEAA);
        }
        if (strcmp(k, "rail") == 0 || strcmp(k, "narrow_gauge") == 0 ||
            strcmp(k, "light_rail") == 0 || strcmp(k, "subway") == 0 ||
            strcmp(k, "tram") == 0 || strcmp(k, "monorail") == 0 ||
            strcmp(k, "funicular") == 0) {
            return pack_hex6(0xB1BBC4);
        }
        if (strcmp(k, "runway") == 0 || strcmp(k, "taxiway") == 0) {
            return pack_hex6(0xCFCDCA);
        }
        if (strcmp(k, "footway") == 0 || strcmp(k, "path") == 0 ||
            strcmp(k, "steps") == 0 || strcmp(k, "pedestrian") == 0 ||
            strcmp(k, "cycleway") == 0 || strcmp(k, "bridleway") == 0) {
            return pack_hex6(0xFBEBFF);
        }
        /* tertiary / residential / service / track / living_street / … */
        return pack_hex6(0xFFFFFF);
    }

    if (strcmp(base, "boundaries") == 0 || strcmp(base, "boundary") == 0) {
        return pack_hex6(0xA6A6C8);
    }
    if (strcmp(base, "pois") == 0 || strcmp(base, "public_transport") == 0) {
        return pack_hex6(0x66626A);
    }
    if (strstr(base, "power") || strstr(base, "electric")) {
        return pack_hex6(0xE67E22);
    }
    if (strstr(base, "fiber") || strstr(base, "fibre") ||
        strstr(base, "telecom")) {
        return pack_hex6(0x9B59B6);
    }

    return pack_hex6(0xD8D2C8);
}

uint32_t webmap_mvt_layer_rgba(const char *name)
{
    return webmap_mvt_feature_rgba(name, NULL);
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

/* ── Feature / Layer message (tags → Shortbread kind) ──────────────── */

#define MVT_MAX_KEYS   256
#define MVT_MAX_VALUES 512
#define MVT_STR_LEN    64

typedef struct {
    char keys[MVT_MAX_KEYS][MVT_STR_LEN];
    size_t n_keys;
    char values[MVT_MAX_VALUES][MVT_STR_LEN]; /* string forms only */
    size_t n_values;
    int kind_key; /* index of "kind" in keys, or -1 */
} mvt_layer_dict_t;

static void copy_str_cap(char *dst, size_t cap, const uint8_t *src, size_t n)
{
    if (n >= cap) {
        n = cap - 1;
    }
    memcpy(dst, src, n);
    dst[n] = '\0';
}

static int parse_mvt_value_string(const uint8_t *data, size_t len, char *out,
                                  size_t out_cap)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;
    out[0] = '\0';
    while (p < end) {
        uint64_t key, v;
        int field, wire;
        if (pb_read_varint(&p, end, &key) != 0) {
            return -1;
        }
        field = (int)(key >> 3);
        wire = (int)(key & 7);
        if (field == 1 && wire == 2) { /* string_value */
            if (pb_read_varint(&p, end, &v) != 0 || p + v > end) {
                return -1;
            }
            copy_str_cap(out, out_cap, p, (size_t)v);
            return 0;
        }
        if (field == 7 && wire == 0) { /* bool_value */
            if (pb_read_varint(&p, end, &v) != 0) {
                return -1;
            }
            snprintf(out, out_cap, "%s", v ? "true" : "false");
            return 0;
        }
        if ((field == 4 || field == 5 || field == 6) && wire == 0) {
            if (pb_read_varint(&p, end, &v) != 0) {
                return -1;
            }
            snprintf(out, out_cap, "%llu", (unsigned long long)v);
            return 0;
        }
        if (pb_skip(&p, end, wire) != 0) {
            return -1;
        }
    }
    return 0;
}

static webmap_mvt_layer_t *find_or_make_sublayer(webmap_mvt_tile_t *tile,
                                                 const char *base,
                                                 const char *kind,
                                                 uint32_t extent,
                                                 webmap_mvt_geom_type_t ghint)
{
    char name[64];
    size_t i;
    webmap_mvt_layer_t L;

    if (kind && kind[0]) {
        snprintf(name, sizeof(name), "%s/%s", base, kind);
    } else {
        snprintf(name, sizeof(name), "%s", base);
    }

    for (i = 0; i < tile->layer_count; i++) {
        if (strcmp(tile->layers[i].name, name) == 0) {
            return &tile->layers[i];
        }
    }

    memset(&L, 0, sizeof(L));
    snprintf(L.name, sizeof(L.name), "%s", name);
    L.extent = extent;
    L.geom_type = ghint;
    if (tile_push_layer(tile, &L) != 0) {
        return NULL;
    }
    return &tile->layers[tile->layer_count - 1];
}

/**
 * Parse one MVT feature into the matching kind-sublayer of @a tile.
 * @a dict supplies key/value tables for tag resolution.
 */
static int parse_feature(const uint8_t *data, size_t len,
                         webmap_mvt_tile_t *tile, const char *layer_name,
                         uint32_t extent, const mvt_layer_dict_t *dict)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;
    const uint8_t *geom = NULL;
    size_t geom_len = 0;
    uint64_t gtype = 0;
    char kind[MVT_STR_LEN];
    uint32_t rgba;
    webmap_mvt_layer_t *L;
    webmap_mvt_geom_type_t ghint = WEBMAP_MVT_UNKNOWN;
    uint32_t tag_kv[128];
    size_t n_tags = 0;
    size_t t;

    kind[0] = '\0';

    while (p < end) {
        uint64_t key, v;
        int field, wire;
        if (pb_read_varint(&p, end, &key) != 0) {
            return -1;
        }
        field = (int)(key >> 3);
        wire = (int)(key & 7);
        if (field == 2 && wire == 2) { /* tags (packed) */
            const uint8_t *tp;
            const uint8_t *tend;
            if (pb_read_varint(&p, end, &v) != 0 || p + v > end) {
                return -1;
            }
            tp = p;
            tend = p + (size_t)v;
            p = tend;
            while (tp < tend && n_tags + 1 < 128) {
                uint64_t tv;
                if (pb_read_varint(&tp, tend, &tv) != 0) {
                    break;
                }
                tag_kv[n_tags++] = (uint32_t)tv;
            }
        } else if (field == 2 && wire == 0) { /* tags (unpacked) */
            if (pb_read_varint(&p, end, &v) != 0) {
                return -1;
            }
            if (n_tags < 128) {
                tag_kv[n_tags++] = (uint32_t)v;
            }
        } else if (field == 3 && wire == 0) { /* type */
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

    /* Resolve kind from tags */
    if (dict && dict->kind_key >= 0) {
        for (t = 0; t + 1 < n_tags; t += 2) {
            if ((int)tag_kv[t] == dict->kind_key &&
                tag_kv[t + 1] < dict->n_values) {
                snprintf(kind, sizeof(kind), "%s",
                         dict->values[tag_kv[t + 1]]);
                break;
            }
        }
    }

    if (gtype == 1) {
        ghint = WEBMAP_MVT_POINT;
    } else if (gtype == 2) {
        ghint = WEBMAP_MVT_LINE;
    } else if (gtype == 3) {
        ghint = WEBMAP_MVT_POLYGON;
    }

    L = find_or_make_sublayer(tile, layer_name, kind[0] ? kind : NULL, extent,
                              ghint);
    if (!L) {
        return -1;
    }
    if (L->geom_type == WEBMAP_MVT_UNKNOWN) {
        L->geom_type = ghint;
    }

    rgba = webmap_mvt_feature_rgba(layer_name, kind[0] ? kind : NULL);

    if (geom && geom_len) {
        return decode_geometry(geom, geom_len, L, rgba);
    }
    return 0;
}

static int parse_layer(const uint8_t *data, size_t len, webmap_mvt_tile_t *tile)
{
    const uint8_t *p = data;
    const uint8_t *end = data + len;
    char layer_name[64];
    uint32_t extent = WEBMAP_DEFAULT_EXTENT;
    mvt_layer_dict_t dict;
    size_t start_layers;

    snprintf(layer_name, sizeof(layer_name), "layer");
    memset(&dict, 0, sizeof(dict));
    dict.kind_key = -1;
    start_layers = tile->layer_count;

    /* First pass: name, extent, keys, values */
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
            if (pb_read_varint(&p, end, &v) != 0 || p + v > end) {
                return -1;
            }
            copy_str_cap(layer_name, sizeof(layer_name), p, (size_t)v);
            p += (size_t)v;
        } else if (field == 3 && wire == 2) { /* keys */
            if (pb_read_varint(&p, end, &v) != 0 || p + v > end) {
                return -1;
            }
            if (dict.n_keys < MVT_MAX_KEYS) {
                copy_str_cap(dict.keys[dict.n_keys], MVT_STR_LEN, p,
                             (size_t)v);
                if (strcmp(dict.keys[dict.n_keys], "kind") == 0) {
                    dict.kind_key = (int)dict.n_keys;
                }
                dict.n_keys++;
            }
            p += (size_t)v;
        } else if (field == 4 && wire == 2) { /* values */
            if (pb_read_varint(&p, end, &v) != 0 || p + v > end) {
                return -1;
            }
            if (dict.n_values < MVT_MAX_VALUES) {
                if (parse_mvt_value_string(p, (size_t)v,
                                           dict.values[dict.n_values],
                                           MVT_STR_LEN) != 0) {
                    dict.values[dict.n_values][0] = '\0';
                }
                dict.n_values++;
            }
            p += (size_t)v;
        } else if (field == 5 && wire == 0) { /* extent */
            if (pb_read_varint(&p, end, &v) != 0) {
                return -1;
            }
            extent = (uint32_t)v;
        } else {
            if (pb_skip(&p, end, wire) != 0) {
                return -1;
            }
        }
    }

    /* Second pass: features → kind sublayers */
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
            if (pb_read_varint(&p, end, &v) != 0 || p + v > end) {
                return -1;
            }
            (void)parse_feature(p, (size_t)v, tile, layer_name, extent, &dict);
            p += (size_t)v;
        } else {
            if (pb_skip(&p, end, wire) != 0) {
                /* drop any partial sublayers from this layer */
                while (tile->layer_count > start_layers) {
                    webmap_mvt_layer_t *L =
                        &tile->layers[tile->layer_count - 1];
                    free(L->vertices);
                    free(L->indices);
                    tile->layer_count--;
                }
                return -1;
            }
        }
    }

    /* Drop empty sublayers created without geometry */
    {
        size_t i = start_layers;
        while (i < tile->layer_count) {
            webmap_mvt_layer_t *L = &tile->layers[i];
            if (L->vertex_count == 0) {
                free(L->vertices);
                free(L->indices);
                if (i + 1 < tile->layer_count) {
                    memmove(L, L + 1,
                            (tile->layer_count - i - 1) * sizeof(*L));
                }
                tile->layer_count--;
                continue;
            }
            i++;
        }
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
