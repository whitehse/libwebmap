/**
 * @file webmap_heap.h
 * @brief Freestanding free-list heap (P4.3). Used by WASM rt and native tests.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef WEBMAP_HEAP_H
#define WEBMAP_HEAP_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    size_t used_bytes;       /* live payload + headers */
    size_t free_bytes;       /* sum of free block payloads+headers */
    size_t capacity_bytes;   /* heap_end - heap_base (committed arena) */
    size_t high_water;       /* max used_bytes since reset */
    size_t alloc_count;
    size_t free_count;
    size_t grow_count;
    size_t watermark_bytes;  /* soft limit; 0 = default from capacity */
    int    over_watermark;   /* 1 if used_bytes > effective watermark */
} webmap_heap_stats_t;

/**
 * Backend for growing linear memory (WASM) or a host test buffer.
 * heap_base is fixed after first init; grow extends the usable end.
 */
typedef struct {
    uintptr_t base;     /* first byte of heap arena */
    size_t    initial;  /* initial usable size from base */
    /** Ensure arena covers at least base+need bytes; return 0 ok, -1 fail. */
    int (*grow_to)(size_t need_from_base);
    /** Current capacity from base (bytes). */
    size_t (*capacity)(void);
} webmap_heap_backend_t;

/** Install backend and reset empty freelist (call once at startup). */
int webmap_heap_init(const webmap_heap_backend_t *backend);

void *webmap_heap_malloc(size_t n);
void  webmap_heap_free(void *p);
void *webmap_heap_calloc(size_t nmemb, size_t size);
void *webmap_heap_realloc(void *ptr, size_t size);

/**
 * Drop all free-list state and treat arena as empty.
 * Only safe when no live pointers remain (module reload / full reset).
 */
void webmap_heap_reset_arena(void);

void webmap_heap_get_stats(webmap_heap_stats_t *out);

/** Soft watermark in bytes of used memory; 0 restores default (3/4 capacity). */
void webmap_heap_set_watermark(size_t bytes);

/** 1 if used_bytes exceeds effective watermark. */
int webmap_heap_over_watermark(void);

#ifdef __cplusplus
}
#endif

#endif /* WEBMAP_HEAP_H */
