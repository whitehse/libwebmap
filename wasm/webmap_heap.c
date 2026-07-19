/**
 * @file webmap_heap.c
 * @brief Free-list allocator with boundary tags + coalescing (P4.3).
 *
 * Block layout (16-byte aligned):
 *   [size_t size | FREE bit][payload …][size_t size | FREE bit]
 * Free blocks store next-free pointer at start of payload.
 */

#include "webmap_heap.h"

#define WM_ALIGN          16u
#define WM_HDR            ((size_t)sizeof(size_t))
#define WM_FTR            ((size_t)sizeof(size_t))
#define WM_MIN_PAYLOAD    ((size_t)sizeof(void *))
#define WM_MIN_BLOCK      (WM_HDR + WM_MIN_PAYLOAD + WM_FTR)
#define WM_FREE_BIT       ((size_t)1)
#define WM_SIZE_MASK      (~(size_t)1)

typedef struct {
    size_t size_field; /* total block size incl headers; low bit = free */
} wm_hdr_t;

static webmap_heap_backend_t g_be;
static int g_inited;
static uintptr_t g_base;
static uintptr_t g_end;       /* one past last committed block */
static wm_hdr_t *g_free_head; /* singly-linked free list (address order) */
static size_t g_used;
static size_t g_high;
static size_t g_nalloc;
static size_t g_nfree;
static size_t g_ngrow;
static size_t g_watermark; /* 0 = auto */

static size_t align_up(size_t n)
{
    return (n + (WM_ALIGN - 1u)) & ~(size_t)(WM_ALIGN - 1u);
}

static size_t blk_size(const wm_hdr_t *b)
{
    return b->size_field & WM_SIZE_MASK;
}

static int blk_is_free(const wm_hdr_t *b)
{
    return (int)(b->size_field & WM_FREE_BIT);
}

static void blk_set(wm_hdr_t *b, size_t total, int free_flag)
{
    size_t f = total & WM_SIZE_MASK;
    if (free_flag) {
        f |= WM_FREE_BIT;
    }
    b->size_field = f;
    {
        size_t *footer =
            (size_t *)((unsigned char *)b + total - WM_FTR);
        *footer = f;
    }
}

static wm_hdr_t *blk_next_phys(wm_hdr_t *b)
{
    return (wm_hdr_t *)((unsigned char *)b + blk_size(b));
}

static wm_hdr_t *blk_prev_phys(wm_hdr_t *b)
{
    unsigned char *p;
    size_t prev_field;
    if ((uintptr_t)b <= g_base) {
        return NULL;
    }
    p = (unsigned char *)b;
    prev_field = *(size_t *)(p - WM_FTR);
    return (wm_hdr_t *)(p - (prev_field & WM_SIZE_MASK));
}

static void **blk_next_free_ptr(wm_hdr_t *b)
{
    return (void **)((unsigned char *)b + WM_HDR);
}

static int in_heap(const void *p)
{
    uintptr_t u = (uintptr_t)p;
    return g_inited && u >= g_base && u < g_end;
}

static size_t free_list_bytes(void)
{
    size_t n = 0;
    wm_hdr_t *b = g_free_head;
    while (b) {
        n += blk_size(b);
        b = (wm_hdr_t *)*blk_next_free_ptr(b);
    }
    return n;
}

static void freelist_remove(wm_hdr_t *blk)
{
    wm_hdr_t **pp = &g_free_head;
    while (*pp) {
        if (*pp == blk) {
            *pp = (wm_hdr_t *)*blk_next_free_ptr(blk);
            return;
        }
        pp = (wm_hdr_t **)blk_next_free_ptr(*pp);
    }
}

static void freelist_insert(wm_hdr_t *blk)
{
    wm_hdr_t **pp = &g_free_head;
    /* Keep free list sorted by address for predictable first-fit. */
    while (*pp && (uintptr_t)*pp < (uintptr_t)blk) {
        pp = (wm_hdr_t **)blk_next_free_ptr(*pp);
    }
    *blk_next_free_ptr(blk) = *pp;
    *pp = blk;
}

static size_t req_total(size_t payload)
{
    size_t n = payload;
    if (n < WM_MIN_PAYLOAD) {
        n = WM_MIN_PAYLOAD;
    }
    n = align_up(n);
    return align_up(WM_HDR + n + WM_FTR);
}

static int ensure_capacity(size_t need_end_from_base)
{
    size_t cap;
    if (!g_be.grow_to || !g_be.capacity) {
        return -1;
    }
    cap = g_be.capacity();
    if (need_end_from_base <= cap) {
        return 0;
    }
    if (g_be.grow_to(need_end_from_base) != 0) {
        return -1;
    }
    g_ngrow++;
    return 0;
}

static void coalesce(wm_hdr_t *b)
{
    wm_hdr_t *next;
    wm_hdr_t *prev;

    /* Forward */
    next = blk_next_phys(b);
    if ((uintptr_t)next < g_end && blk_is_free(next)) {
        freelist_remove(next);
        blk_set(b, blk_size(b) + blk_size(next), 1);
    }
    /* Backward */
    prev = blk_prev_phys(b);
    if (prev && blk_is_free(prev)) {
        freelist_remove(prev);
        freelist_remove(b);
        blk_set(prev, blk_size(prev) + blk_size(b), 1);
        freelist_insert(prev);
        return;
    }
    /* b already free; ensure on list once */
    freelist_remove(b);
    freelist_insert(b);
}

int webmap_heap_init(const webmap_heap_backend_t *backend)
{
    if (!backend || !backend->base || !backend->grow_to || !backend->capacity) {
        return -1;
    }
    g_be = *backend;
    g_base = backend->base;
    g_end = g_base; /* empty until first alloc grows/carves */
    g_free_head = NULL;
    g_used = 0;
    g_high = 0;
    g_nalloc = 0;
    g_nfree = 0;
    g_ngrow = 0;
    g_watermark = 0;
    g_inited = 1;
    if (backend->initial > 0) {
        if (ensure_capacity(backend->initial) != 0) {
            g_inited = 0;
            return -1;
        }
        /* initial capacity reserved but no blocks until malloc */
        (void)backend->initial;
    }
    return 0;
}

void webmap_heap_reset_arena(void)
{
    if (!g_inited) {
        return;
    }
    g_free_head = NULL;
    g_end = g_base;
    g_used = 0;
    g_high = 0;
    g_nalloc = 0;
    g_nfree = 0;
    /* capacity / grow_count retained — linear memory pages stay */
}

void *webmap_heap_malloc(size_t n)
{
    size_t need;
    wm_hdr_t *b;
    wm_hdr_t **pp;
    uintptr_t new_end;

    if (!g_inited) {
        return NULL;
    }
    if (n == 0) {
        n = 1;
    }
    need = req_total(n);

    /* First-fit free list */
    pp = &g_free_head;
    while (*pp) {
        b = *pp;
        if (blk_size(b) >= need) {
            *pp = (wm_hdr_t *)*blk_next_free_ptr(b);
            if (blk_size(b) >= need + WM_MIN_BLOCK) {
                size_t rest = blk_size(b) - need;
                blk_set(b, need, 0);
                {
                    wm_hdr_t *r = blk_next_phys(b);
                    blk_set(r, rest, 1);
                    freelist_insert(r);
                }
            } else {
                blk_set(b, blk_size(b), 0);
            }
            g_used += blk_size(b);
            if (g_used > g_high) {
                g_high = g_used;
            }
            g_nalloc++;
            return (unsigned char *)b + WM_HDR;
        }
        pp = (wm_hdr_t **)blk_next_free_ptr(b);
    }

    /* Extend arena */
    new_end = g_end + need;
    if (new_end < g_end) {
        return NULL; /* overflow */
    }
    if (ensure_capacity((size_t)(new_end - g_base)) != 0) {
        return NULL;
    }
    b = (wm_hdr_t *)g_end;
    blk_set(b, need, 0);
    g_end = new_end;
    g_used += need;
    if (g_used > g_high) {
        g_high = g_used;
    }
    g_nalloc++;
    return (unsigned char *)b + WM_HDR;
}

void webmap_heap_free(void *p)
{
    wm_hdr_t *b;
    if (!p || !g_inited || !in_heap(p)) {
        return;
    }
    b = (wm_hdr_t *)((unsigned char *)p - WM_HDR);
    if ((uintptr_t)b < g_base || (uintptr_t)b >= g_end) {
        return;
    }
    if (blk_is_free(b)) {
        return; /* double free: ignore */
    }
    if (g_used >= blk_size(b)) {
        g_used -= blk_size(b);
    } else {
        g_used = 0;
    }
    g_nfree++;
    blk_set(b, blk_size(b), 1);
    freelist_insert(b);
    coalesce(b);
}

void *webmap_heap_calloc(size_t nmemb, size_t size)
{
    size_t n;
    void *p;
    unsigned char *b;
    size_t i;
    if (size != 0 && nmemb > (size_t)-1 / size) {
        return NULL;
    }
    n = nmemb * size;
    p = webmap_heap_malloc(n);
    if (!p) {
        return NULL;
    }
    b = (unsigned char *)p;
    for (i = 0; i < n; i++) {
        b[i] = 0;
    }
    return p;
}

void *webmap_heap_realloc(void *ptr, size_t size)
{
    wm_hdr_t *b;
    size_t old_payload;
    void *n;
    unsigned char *d;
    const unsigned char *s;
    size_t i;
    size_t copy;

    if (!ptr) {
        return webmap_heap_malloc(size);
    }
    if (size == 0) {
        webmap_heap_free(ptr);
        return NULL;
    }
    if (!in_heap(ptr)) {
        return NULL;
    }
    b = (wm_hdr_t *)((unsigned char *)ptr - WM_HDR);
    if (blk_is_free(b)) {
        return NULL;
    }
    old_payload = blk_size(b) - WM_HDR - WM_FTR;
    if (req_total(size) <= blk_size(b)) {
        /* in-place shrink: optional split */
        if (blk_size(b) >= req_total(size) + WM_MIN_BLOCK) {
            size_t need = req_total(size);
            size_t rest = blk_size(b) - need;
            if (g_used >= blk_size(b)) {
                g_used -= blk_size(b);
            }
            blk_set(b, need, 0);
            g_used += need;
            {
                wm_hdr_t *r = blk_next_phys(b);
                blk_set(r, rest, 1);
                freelist_insert(r);
                coalesce(r);
            }
        }
        return ptr;
    }
    n = webmap_heap_malloc(size);
    if (!n) {
        return NULL;
    }
    copy = old_payload < size ? old_payload : size;
    d = (unsigned char *)n;
    s = (const unsigned char *)ptr;
    for (i = 0; i < copy; i++) {
        d[i] = s[i];
    }
    webmap_heap_free(ptr);
    return n;
}

void webmap_heap_get_stats(webmap_heap_stats_t *out)
{
    size_t cap;
    size_t wm;
    if (!out) {
        return;
    }
    cap = (g_inited && g_be.capacity) ? g_be.capacity() : 0;
    wm = g_watermark ? g_watermark : (cap - cap / 4u); /* default 75% */
    out->used_bytes = g_used;
    out->free_bytes = free_list_bytes();
    out->capacity_bytes = cap;
    out->high_water = g_high;
    out->alloc_count = g_nalloc;
    out->free_count = g_nfree;
    out->grow_count = g_ngrow;
    out->watermark_bytes = wm;
    out->over_watermark = (wm > 0 && g_used > wm) ? 1 : 0;
}

void webmap_heap_set_watermark(size_t bytes)
{
    g_watermark = bytes;
}

int webmap_heap_over_watermark(void)
{
    webmap_heap_stats_t s;
    webmap_heap_get_stats(&s);
    return s.over_watermark;
}
