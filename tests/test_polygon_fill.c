#include "webmap.h"
#include "webmap_mvt.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

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

static uint32_t zz(int32_t n)
{
    return ((uint32_t)n << 1) ^ (uint32_t)(n >> 31);
}

/** Square polygon (0,0)-(100,0)-(100,100)-(0,100) as MVT POLYGON. */
static size_t build_poly_mvt(uint8_t *out, size_t cap)
{
    uint8_t geom[64];
    uint8_t feat[96];
    uint8_t layer[160];
    size_t g = 0, f = 0, l = 0, o = 0;
    uint32_t cmd;

    cmd = (1u << 3) | 1u; /* MoveTo 1 */
    g += put_varint(geom + g, cmd);
    g += put_varint(geom + g, zz(0));
    g += put_varint(geom + g, zz(0));
    cmd = (3u << 3) | 2u; /* LineTo 3 */
    g += put_varint(geom + g, cmd);
    g += put_varint(geom + g, zz(100));
    g += put_varint(geom + g, zz(0));
    g += put_varint(geom + g, zz(0));
    g += put_varint(geom + g, zz(100));
    g += put_varint(geom + g, zz(-100));
    g += put_varint(geom + g, zz(0));
    g += put_varint(geom + g, 7); /* ClosePath */

    f += put_varint(feat + f, (3u << 3) | 0);
    f += put_varint(feat + f, 3); /* POLYGON */
    f += put_varint(feat + f, (4u << 3) | 2);
    f += put_varint(feat + f, g);
    memcpy(feat + f, geom, g);
    f += g;

    {
        const char *name = "land";
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

    o += put_varint(out + o, (3u << 3) | 2);
    o += put_varint(out + o, l);
    if (o + l > cap) {
        return 0;
    }
    memcpy(out + o, layer, l);
    return o + l;
}

static void test_earclip_square(void)
{
    uint8_t buf[256];
    size_t n = build_poly_mvt(buf, sizeof(buf));
    webmap_mvt_tile_t tile;
    assert(n > 0);
    assert(webmap_mvt_decode(buf, n, &tile) == 0);
    assert(tile.layer_count == 1);
    assert(tile.layers[0].geom_type == WEBMAP_MVT_POLYGON ||
           tile.layers[0].vertex_count >= 4);
    /* Square → 2 triangles = 6 indices */
    assert(tile.layers[0].index_count >= 6);
    assert(tile.layers[0].index_count % 3 == 0);
    printf("  PASS: polygon verts=%zu inds=%zu\n",
           tile.layers[0].vertex_count, tile.layers[0].index_count);
    webmap_mvt_tile_free(&tile);
}

int main(void)
{
    printf("webmap_polygon:\n");
    test_earclip_square();
    printf("ALL PASS\n");
    return 0;
}
