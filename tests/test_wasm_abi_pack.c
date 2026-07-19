/**
 * P4.4: record host-native packing (contrast) and assert wasm32 expectations
 * documented in ADR-024 for fields that match on both targets (vertex, tile_id).
 */
#include "webmap.h"

#include <assert.h>
#include <stddef.h>
#include <stdio.h>

int main(void)
{
    printf("webmap_wasm_abi_pack (host contrast):\n");
    printf("  sizeof(void*)=%zu size_t=%zu\n", sizeof(void *), sizeof(size_t));
    printf("  webmap_vertex_t=%zu\n", sizeof(webmap_vertex_t));
    printf("  webmap_tile_id_t=%zu z@%zu x@%zu y@%zu\n",
           sizeof(webmap_tile_id_t), offsetof(webmap_tile_id_t, z),
           offsetof(webmap_tile_id_t, x), offsetof(webmap_tile_id_t, y));
    printf("  webmap_gpu_layer_t=%zu verts@%zu vc@%zu name@%zu extent@%zu\n",
           sizeof(webmap_gpu_layer_t), offsetof(webmap_gpu_layer_t, vertices),
           offsetof(webmap_gpu_layer_t, vertex_count),
           offsetof(webmap_gpu_layer_t, name),
           offsetof(webmap_gpu_layer_t, extent));
    printf("  webmap_config_t=%zu\n", sizeof(webmap_config_t));

    /* Portable layout: vertex and tile_id match wasm32 table in ADR-024. */
    assert(sizeof(webmap_vertex_t) == 12);
    assert(sizeof(webmap_tile_id_t) == 12);
    assert(offsetof(webmap_tile_id_t, z) == 0);
    assert(offsetof(webmap_tile_id_t, x) == 4);
    assert(offsetof(webmap_tile_id_t, y) == 8);

    /*
     * On wasm32, ptr/size_t are 4 B and gpu_layer is 92 B.
     * On host x86_64 they are larger — only assert portable fields here.
     * Full wasm32 table is exported by webmap_wasm_abi_pack_ptr in the module.
     */
    if (sizeof(void *) == 4 && sizeof(size_t) == 4) {
        assert(sizeof(webmap_gpu_layer_t) == 92);
        assert(offsetof(webmap_gpu_layer_t, vertices) == 0);
        assert(offsetof(webmap_gpu_layer_t, vertex_count) == 4);
        assert(offsetof(webmap_gpu_layer_t, name) == 24);
        assert(offsetof(webmap_gpu_layer_t, extent) == 88);
        printf("  PASS: wasm32-width packing matches ADR-024\n");
    } else {
        printf("  PASS: portable fields ok (host %zu-bit; see module export for wasm32)\n",
               sizeof(void *) * 8);
    }
    return 0;
}
