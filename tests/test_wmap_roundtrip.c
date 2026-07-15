#include "webmap.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void test_roundtrip(void)
{
    webmap_vertex_t verts[3] = {
        {0.f, 0.f, 0xFF0000FFu},
        {100.f, 0.f, 0xFF0000FFu},
        {100.f, 100.f, 0xFF0000FFu},
    };
    uint32_t inds[4] = {0, 1, 1, 2};
    webmap_gpu_layer_t layer;
    webmap_tile_id_t id = {12, 1200, 1900};
    uint8_t buf[4096];
    size_t n;
    webmap_ctx_t *ctx;
    webmap_gpu_layer_t out[4];
    size_t nl;
    webmap_event_t ev;
    webmap_tile_id_t peek_id;
    uint32_t peek_n = 0;

    memset(&layer, 0, sizeof(layer));
    layer.vertices = verts;
    layer.vertex_count = 3;
    layer.indices = inds;
    layer.index_count = 4;
    layer.kind = WEBMAP_LAYER_LINE;
    layer.feature_class = WEBMAP_CLASS_BASEMAP;
    snprintf(layer.name, sizeof(layer.name), "road");
    layer.extent = 4096;

    n = webmap_wmap_encode(id, &layer, 1, buf, sizeof(buf));
    assert(n > 24);
    assert(webmap_wmap_peek(buf, n, &peek_id, &peek_n) == 0);
    assert(peek_id.z == 12 && peek_id.x == 1200 && peek_id.y == 1900);
    assert(peek_n == 1);

    ctx = webmap_create();
    assert(webmap_load_wmap_tile(ctx, buf, n) == 0);
    assert(webmap_tile_count(ctx) == 1);
    assert(webmap_next_event(ctx, &ev) == 1);
    assert(ev.type == WEBMAP_EVENT_TILE_LOADED);

    nl = webmap_get_tile_layers(ctx, id, out, 4);
    assert(nl == 1);
    assert(out[0].vertex_count == 3);
    assert(out[0].index_count == 4);
    assert(out[0].vertices[1].x == 100.f);
    assert(strcmp(out[0].name, "road") == 0);

    webmap_destroy(ctx);
    printf("  PASS: wmap encode/load roundtrip\n");
}

int main(void)
{
    printf("webmap_wmap_roundtrip:\n");
    test_roundtrip();
    printf("ALL PASS\n");
    return 0;
}
