/**
 * P4.2: tile cache max_tiles eviction (LRU + TILE_EVICTED events).
 */
#include "webmap.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static size_t encode_simple(webmap_tile_id_t id, uint8_t *buf, size_t cap)
{
    webmap_vertex_t verts[2] = {
        {0.f, 0.f, 0xFF0000FFu},
        {10.f, 10.f, 0xFF0000FFu},
    };
    uint32_t inds[2] = {0, 1};
    webmap_gpu_layer_t layer;

    memset(&layer, 0, sizeof(layer));
    layer.vertices = verts;
    layer.vertex_count = 2;
    layer.indices = inds;
    layer.index_count = 2;
    layer.kind = WEBMAP_LAYER_LINE;
    layer.feature_class = WEBMAP_CLASS_BASEMAP;
    snprintf(layer.name, sizeof(layer.name), "t");
    layer.extent = 4096;
    return webmap_wmap_encode(id, &layer, 1, buf, cap);
}

static int drain_events(webmap_ctx_t *ctx, int *loaded, int *evicted,
                        webmap_tile_id_t *last_evicted)
{
    webmap_event_t ev;
    int n = 0;
    while (webmap_next_event(ctx, &ev) == 1) {
        n++;
        if (ev.type == WEBMAP_EVENT_TILE_LOADED && loaded) {
            (*loaded)++;
        }
        if (ev.type == WEBMAP_EVENT_TILE_EVICTED) {
            if (evicted) {
                (*evicted)++;
            }
            if (last_evicted) {
                *last_evicted = ev.tile;
            }
        }
    }
    return n;
}

static void test_drop_tile(void)
{
    webmap_config_t cfg = webmap_default_config();
    webmap_ctx_t *ctx;
    uint8_t buf[2048];
    size_t n;
    webmap_tile_id_t id0 = {10, 100, 200};
    webmap_tile_id_t id1 = {10, 101, 200};
    webmap_tile_id_t missing = {10, 999, 999};
    int loaded = 0, evicted = 0;

    cfg.max_tiles = 8;
    cfg.event_queue_size = 16;
    ctx = webmap_create_with_config(&cfg);
    assert(ctx != NULL);

    n = encode_simple(id0, buf, sizeof(buf));
    assert(webmap_load_wmap_tile(ctx, buf, n) == 0);
    n = encode_simple(id1, buf, sizeof(buf));
    assert(webmap_load_wmap_tile(ctx, buf, n) == 0);
    drain_events(ctx, &loaded, &evicted, NULL);
    assert(webmap_tile_count(ctx) == 2);

    assert(webmap_drop_tile(ctx, id0) == 0);
    loaded = 0;
    evicted = 0;
    drain_events(ctx, &loaded, &evicted, NULL);
    assert(evicted == 1);
    assert(webmap_tile_count(ctx) == 1);

    assert(webmap_drop_tile(ctx, missing) == 1);
    assert(webmap_tile_count(ctx) == 1);

    assert(webmap_drop_tile(ctx, id1) == 0);
    assert(webmap_tile_count(ctx) == 0);

    /* Drop on empty is not-found */
    assert(webmap_drop_tile(ctx, id1) == 1);
    assert(webmap_drop_tile(NULL, id0) == -1);

    webmap_destroy(ctx);
    printf("ok drop_tile\n");
}

static void test_max_tiles_eviction(void)
{
    webmap_config_t cfg = webmap_default_config();
    webmap_ctx_t *ctx;
    uint8_t buf[2048];
    size_t n;
    webmap_tile_id_t id0 = {10, 100, 200};
    webmap_tile_id_t id1 = {10, 101, 200};
    webmap_tile_id_t id2 = {10, 102, 200};
    webmap_tile_id_t id3 = {10, 103, 200};
    webmap_gpu_layer_t layers[4];
    int loaded = 0, evicted = 0;
    webmap_tile_id_t last_ev = {0, 0, 0};

    cfg.max_tiles = 2;
    cfg.event_queue_size = 16;
    ctx = webmap_create_with_config(&cfg);
    assert(ctx != NULL);

    n = encode_simple(id0, buf, sizeof(buf));
    assert(n > 24);
    assert(webmap_load_wmap_tile(ctx, buf, n) == 0);
    drain_events(ctx, &loaded, &evicted, &last_ev);
    assert(webmap_tile_count(ctx) == 1);
    assert(loaded == 1);
    assert(evicted == 0);

    n = encode_simple(id1, buf, sizeof(buf));
    assert(webmap_load_wmap_tile(ctx, buf, n) == 0);
    drain_events(ctx, &loaded, &evicted, &last_ev);
    assert(webmap_tile_count(ctx) == 2);
    assert(evicted == 0);

    /* Capacity full — next load must evict LRU (id0, never touched after load). */
    n = encode_simple(id2, buf, sizeof(buf));
    assert(webmap_load_wmap_tile(ctx, buf, n) == 0);
    drain_events(ctx, &loaded, &evicted, &last_ev);
    assert(webmap_tile_count(ctx) == 2);
    assert(evicted == 1);
    assert(last_ev.z == id0.z && last_ev.x == id0.x && last_ev.y == id0.y);
    assert(webmap_get_tile_layers(ctx, id0, layers, 4) == 0);
    assert(webmap_get_tile_layers(ctx, id1, layers, 4) == 1);
    assert(webmap_get_tile_layers(ctx, id2, layers, 4) == 1);

    /* Touch id1 so id2 becomes older; load id3 → evict id2. */
    assert(webmap_get_tile_layers(ctx, id1, layers, 4) == 1);
    n = encode_simple(id3, buf, sizeof(buf));
    assert(webmap_load_wmap_tile(ctx, buf, n) == 0);
    evicted = 0;
    drain_events(ctx, &loaded, &evicted, &last_ev);
    assert(webmap_tile_count(ctx) == 2);
    assert(evicted == 1);
    assert(last_ev.z == id2.z && last_ev.x == id2.x && last_ev.y == id2.y);
    assert(webmap_get_tile_layers(ctx, id1, layers, 4) == 1);
    assert(webmap_get_tile_layers(ctx, id3, layers, 4) == 1);
    assert(webmap_get_tile_layers(ctx, id2, layers, 4) == 0);

    webmap_destroy(ctx);
    printf("  PASS: max_tiles LRU eviction + TILE_EVICTED\n");
}

static void test_reload_same_tile_no_grow(void)
{
    webmap_config_t cfg = webmap_default_config();
    webmap_ctx_t *ctx;
    uint8_t buf[2048];
    size_t n;
    webmap_tile_id_t id = {8, 1, 2};
    int loaded = 0, evicted = 0;

    cfg.max_tiles = 1;
    ctx = webmap_create_with_config(&cfg);
    assert(ctx);

    n = encode_simple(id, buf, sizeof(buf));
    assert(webmap_load_wmap_tile(ctx, buf, n) == 0);
    assert(webmap_load_wmap_tile(ctx, buf, n) == 0);
    drain_events(ctx, &loaded, &evicted, NULL);
    assert(webmap_tile_count(ctx) == 1);
    /* Reload replaces in place — no eviction event required. */
    assert(evicted == 0);

    webmap_destroy(ctx);
    printf("  PASS: reload same tile stays at count 1\n");
}

int main(void)
{
    printf("webmap_tile_eviction:\n");
    test_max_tiles_eviction();
    test_reload_same_tile_no_grow();
    test_drop_tile();
    printf("ALL PASS\n");
    return 0;
}
