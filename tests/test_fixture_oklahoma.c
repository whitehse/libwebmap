#include "webmap.h"
#include "webmap_mvt.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint8_t *read_file(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    uint8_t *buf;
    long sz;
    if (!f) {
        return NULL;
    }
    fseek(f, 0, SEEK_END);
    sz = ftell(f);
    rewind(f);
    if (sz <= 0) {
        fclose(f);
        return NULL;
    }
    buf = malloc((size_t)sz);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) {
        free(buf);
        fclose(f);
        return NULL;
    }
    fclose(f);
    *out_len = (size_t)sz;
    return buf;
}

int main(void)
{
    const char *paths[] = {
        "fixtures/tulsa_z10/238_401.pbf",
        "data/oklahoma_counties_pbf/10/238/401.pbf",
        NULL};
    const char *path = NULL;
    size_t i, len = 0;
    uint8_t *data = NULL;
    webmap_mvt_tile_t mvt;
    webmap_gpu_layer_t layer;
    webmap_tile_id_t id = {10, 238, 401};
    uint8_t *wmap = NULL;
    size_t wlen = 0, cap;
    webmap_ctx_t *ctx;

    printf("webmap_fixture_ok:\n");
    for (i = 0; paths[i]; i++) {
        data = read_file(paths[i], &len);
        if (data) {
            path = paths[i];
            break;
        }
    }
    if (!data) {
        printf("  SKIP: no Oklahoma fixture present (run extract script)\n");
        return 0;
    }
    printf("  using %s (%zu bytes)\n", path, len);

    assert(webmap_mvt_decode(data, len, &mvt) == 0);
    assert(mvt.layer_count > 0);
    printf("  layers=%zu first=%s verts=%zu inds=%zu\n", mvt.layer_count,
           mvt.layers[0].name, mvt.layers[0].vertex_count,
           mvt.layers[0].index_count);

    layer.vertices = mvt.layers[0].vertices;
    layer.vertex_count = mvt.layers[0].vertex_count;
    layer.indices = mvt.layers[0].indices;
    layer.index_count = mvt.layers[0].index_count;
    layer.kind = WEBMAP_LAYER_LINE;
    layer.feature_class = WEBMAP_CLASS_BASEMAP;
    snprintf(layer.name, sizeof(layer.name), "%s", mvt.layers[0].name);
    layer.extent = mvt.layers[0].extent;

    cap = len * 8 + 65536;
    wmap = malloc(cap);
    assert(wmap);
    wlen = webmap_wmap_encode(id, &layer, 1, wmap, cap);
    assert(wlen > 0);

    ctx = webmap_create();
    assert(webmap_load_wmap_tile(ctx, wmap, wlen) == 0);
    assert(webmap_tile_count(ctx) == 1);
    webmap_destroy(ctx);

    free(wmap);
    free(data);
    webmap_mvt_tile_free(&mvt);
    printf("  PASS: GeoFabrik Shortbread Tulsa tile roundtrip\n");
    printf("ALL PASS\n");
    return 0;
}
