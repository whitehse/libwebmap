/**
 * P4.3: free-list heap unit tests (host-simulated linear arena).
 */
#include "webmap_heap.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#define SIM_SIZE (2u * 1024u * 1024u)
#define SIM_BASE 4096u

static unsigned char sim_mem[SIM_SIZE];
static size_t sim_cap;

static size_t host_capacity(void)
{
    return sim_cap;
}

static int host_grow_to(size_t need_from_base)
{
    if (SIM_BASE + need_from_base > SIM_SIZE) {
        return -1;
    }
    if (need_from_base > sim_cap) {
        sim_cap = need_from_base;
    }
    return 0;
}

static void setup(void)
{
    webmap_heap_backend_t be;
    memset(sim_mem, 0, sizeof(sim_mem));
    sim_cap = 0;
    be.base = (uintptr_t)(sim_mem + SIM_BASE);
    be.initial = 0;
    be.grow_to = host_grow_to;
    be.capacity = host_capacity;
    assert(webmap_heap_init(&be) == 0);
}

static void test_alloc_free_reuse(void)
{
    void *a, *b, *c;
    webmap_heap_stats_t s;

    setup();
    a = webmap_heap_malloc(64);
    b = webmap_heap_malloc(128);
    assert(a && b);
    assert(a != b);
    webmap_heap_get_stats(&s);
    assert(s.used_bytes > 0);
    assert(s.alloc_count == 2);

    webmap_heap_free(a);
    webmap_heap_get_stats(&s);
    assert(s.free_bytes > 0);
    assert(s.free_count == 1);

    c = webmap_heap_malloc(64);
    assert(c != NULL);
    /* Prefer reusing freed block (first-fit). */
    assert(c == a);
    webmap_heap_free(b);
    webmap_heap_free(c);
    webmap_heap_get_stats(&s);
    assert(s.used_bytes == 0);
    printf("  PASS: alloc/free reuse\n");
}

static void test_coalesce(void)
{
    void *a, *b, *c;
    webmap_heap_stats_t s;
    size_t free_after;

    setup();
    a = webmap_heap_malloc(100);
    b = webmap_heap_malloc(100);
    c = webmap_heap_malloc(100);
    assert(a && b && c);
    webmap_heap_free(a);
    webmap_heap_free(b);
    /* a+b should coalesce → one free block large enough for 200 */
    webmap_heap_get_stats(&s);
    free_after = s.free_bytes;
    assert(free_after > 0);

    webmap_heap_free(c);
    webmap_heap_get_stats(&s);
    assert(s.used_bytes == 0);
    /* single free region after full free */
    assert(s.free_bytes >= free_after);

    a = webmap_heap_malloc(280);
    assert(a != NULL);
    webmap_heap_free(a);
    printf("  PASS: coalesce adjacent frees\n");
}

static void test_calloc_realloc(void)
{
    unsigned char *p;
    size_t i;
    void *q;

    setup();
    p = (unsigned char *)webmap_heap_calloc(32, 4);
    assert(p);
    for (i = 0; i < 128; i++) {
        assert(p[i] == 0);
    }
    p[0] = 0xAB;
    q = webmap_heap_realloc(p, 256);
    assert(q);
    assert(((unsigned char *)q)[0] == 0xAB);
    webmap_heap_free(q);
    printf("  PASS: calloc + realloc\n");
}

static void test_reset_arena(void)
{
    void *a;
    webmap_heap_stats_t s;

    setup();
    a = webmap_heap_malloc(512);
    assert(a);
    webmap_heap_reset_arena();
    webmap_heap_get_stats(&s);
    assert(s.used_bytes == 0);
    assert(s.alloc_count == 0);
    a = webmap_heap_malloc(64);
    assert(a);
    webmap_heap_free(a);
    printf("  PASS: reset_arena\n");
}

static void test_watermark(void)
{
    void *blocks[32];
    int i;
    webmap_heap_stats_t s;

    setup();
    webmap_heap_set_watermark(4096);
    for (i = 0; i < 32; i++) {
        blocks[i] = webmap_heap_malloc(256);
        assert(blocks[i]);
    }
    webmap_heap_get_stats(&s);
    assert(s.over_watermark == 1);
    assert(webmap_heap_over_watermark() == 1);
    for (i = 0; i < 32; i++) {
        webmap_heap_free(blocks[i]);
    }
    webmap_heap_get_stats(&s);
    assert(s.over_watermark == 0);
    printf("  PASS: watermark\n");
}

static void test_double_free_safe(void)
{
    void *a;
    setup();
    a = webmap_heap_malloc(32);
    webmap_heap_free(a);
    webmap_heap_free(a); /* must not corrupt */
    a = webmap_heap_malloc(32);
    assert(a);
    webmap_heap_free(a);
    printf("  PASS: double free ignored\n");
}

int main(void)
{
    printf("webmap_wasm_heap (P4.3):\n");
    test_alloc_free_reuse();
    test_coalesce();
    test_calloc_realloc();
    test_reset_arena();
    test_watermark();
    test_double_free_safe();
    printf("ALL PASS\n");
    return 0;
}
