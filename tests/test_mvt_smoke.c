#include "webmap.h"
#include "webmap_mvt.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Encode a protobuf varint. */
static size_t put_varint(uint8_t *p, uint64_t v)
{
    size_t n = 0;
    do {
        uint8_t b = (uint8_t)(v & 0x7F);
        v >>= 7;
        if (v) {
            b |= 0x80;
        }
        p[n++] = b;
    } while (v);
    return n;
}

static uint32_t zig_zag_encode(int32_t n)
{
    return ((uint32_t)n << 1) ^ (uint32_t)(n >> 31);
}

/**
 * Build a minimal MVT tile:
 *   Layer "road" with one LineString (0,0) -> (100,0) -> (100,100)
 */
static size_t build_minimal_mvt(uint8_t *out, size_t cap)
{
    uint8_t geom[32];
    uint8_t feat[64];
    uint8_t layer[128];
    size_t g = 0, f = 0, l = 0, o = 0;
    uint32_t cmd;

    /* geometry: MoveTo(1) + LineTo(2) */
    cmd = (1u << 3) | 1u; /* MoveTo count=1 */
    g += put_varint(geom + g, cmd);
    g += put_varint(geom + g, zig_zag_encode(0));
    g += put_varint(geom + g, zig_zag_encode(0));
    cmd = (2u << 3) | 2u; /* LineTo count=2 */
    g += put_varint(geom + g, cmd);
    g += put_varint(geom + g, zig_zag_encode(100));
    g += put_varint(geom + g, zig_zag_encode(0));
    g += put_varint(geom + g, zig_zag_encode(0));
    g += put_varint(geom + g, zig_zag_encode(100));

    /* Feature: type=LINESTRING(2), geometry */
    f += put_varint(feat + f, (3u << 3) | 0); /* field 3 varint type */
    f += put_varint(feat + f, 2);             /* LINESTRING */
    f += put_varint(feat + f, (4u << 3) | 2); /* field 4 bytes geometry */
    f += put_varint(feat + f, g);
    memcpy(feat + f, geom, g);
    f += g;

    /* Layer: name="road", feature, extent=4096 */
    {
        const char *name = "road";
        size_t nlen = strlen(name);
        l += put_varint(layer + l, (1u << 3) | 2);
        l += put_varint(layer + l, nlen);
        memcpy(layer + l, name, nlen);
        l += nlen;
        l += put_varint(layer + l, (2u << 3) | 2);
        l += put_varint(layer + l, f);
        memcpy(layer + l, feat, f);
        l += f;
        l += put_varint(layer + l, (5u << 3) | 0);
        l += put_varint(layer + l, 4096);
    }

    /* Tile: layers */
    o += put_varint(out + o, (3u << 3) | 2);
    o += put_varint(out + o, l);
    if (o + l > cap) {
        return 0;
    }
    memcpy(out + o, layer, l);
    o += l;
    return o;
}

static void test_mvt_decode_line(void)
{
    uint8_t buf[256];
    size_t n = build_minimal_mvt(buf, sizeof(buf));
    webmap_mvt_tile_t tile;
    assert(n > 0);
    assert(webmap_mvt_decode(buf, n, &tile) == 0);
    assert(tile.layer_count == 1);
    assert(strcmp(tile.layers[0].name, "road") == 0);
    assert(tile.layers[0].vertex_count == 3);
    assert(tile.layers[0].index_count >= 2);
    assert(tile.layers[0].vertices[1].x == 100.f);
    webmap_mvt_tile_free(&tile);
    printf("  PASS: mvt line decode\n");
}

static void test_mvt_to_wmap(void)
{
    uint8_t mvt[256];
    size_t mvt_len = build_minimal_mvt(mvt, sizeof(mvt));
    webmap_mvt_tile_t tile;
    webmap_gpu_layer_t layer;
    webmap_tile_id_t id = {8, 50, 100};
    uint8_t wmap[4096];
    size_t wlen;
    webmap_ctx_t *ctx;

    assert(webmap_mvt_decode(mvt, mvt_len, &tile) == 0);
    memset(&layer, 0, sizeof(layer));
    layer.vertices = tile.layers[0].vertices;
    layer.vertex_count = tile.layers[0].vertex_count;
    layer.indices = tile.layers[0].indices;
    layer.index_count = tile.layers[0].index_count;
    layer.kind = WEBMAP_LAYER_LINE;
    layer.feature_class = WEBMAP_CLASS_BASEMAP;
    snprintf(layer.name, sizeof(layer.name), "%s", tile.layers[0].name);
    layer.extent = tile.layers[0].extent;

    wlen = webmap_wmap_encode(id, &layer, 1, wmap, sizeof(wmap));
    assert(wlen > 0);

    ctx = webmap_create();
    assert(webmap_load_wmap_tile(ctx, wmap, wlen) == 0);
    assert(webmap_tile_count(ctx) == 1);
    webmap_destroy(ctx);
    webmap_mvt_tile_free(&tile);
    printf("  PASS: mvt → wmap → load\n");
}

int main(void)
{
    printf("webmap_mvt_smoke:\n");
    test_mvt_decode_line();
    test_mvt_to_wmap();
    printf("ALL PASS\n");
    return 0;
}
