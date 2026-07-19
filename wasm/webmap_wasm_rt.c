/**
 * @file webmap_wasm_rt.c
 * @brief Freestanding WASM runtime: free-list heap + libc/math shims (no Emscripten).
 *
 * P4.3: free-list malloc/free with coalescing (wasm/webmap_heap.c); watermark
 * stats for host reload safety. Bump allocator retired.
 *
 * Build: clang --target=wasm32 -nostdlib -ffreestanding …
 * Documented in docs/decisions/010, docs/guides/wasm.md
 */

#include "webmap_heap.h"

#include <stddef.h>
#include <stdint.h>

/* ── WASM linear-memory backend ────────────────────────────────────── */

/*
 * Heap must start *above* the linker stack region.
 * wasm-ld places __stack_pointer just above static data (~64–80 KiB with a
 * small default stack). Growing the freelist heap from 64 KiB collides with
 * the stack and hangs create/calloc. Reserve low 1 MiB for stack + data.
 */
#define WM_WASM_HEAP_BASE (1024u * 1024u)

static size_t wasm_capacity(void)
{
    size_t total = (size_t)__builtin_wasm_memory_size(0) * 65536u;
    if (total <= WM_WASM_HEAP_BASE) {
        return 0;
    }
    return total - WM_WASM_HEAP_BASE;
}

static int wasm_grow_to(size_t need_from_base)
{
    size_t end = WM_WASM_HEAP_BASE + need_from_base;
    size_t pages = (size_t)__builtin_wasm_memory_size(0);
    size_t need_pages;
    if (end < WM_WASM_HEAP_BASE) {
        return -1;
    }
    need_pages = (end + 65535u) / 65536u;
    if (need_pages > pages) {
        if (__builtin_wasm_memory_grow(0, need_pages - pages) == (size_t)-1) {
            return -1;
        }
    }
    return 0;
}

static int heap_ready;

static void ensure_heap(void)
{
    webmap_heap_backend_t be;
    if (heap_ready) {
        return;
    }
    be.base = WM_WASM_HEAP_BASE;
    be.initial = 0;
    be.grow_to = wasm_grow_to;
    be.capacity = wasm_capacity;
    if (webmap_heap_init(&be) == 0) {
        heap_ready = 1;
    }
}

void *malloc(size_t n)
{
    ensure_heap();
    return webmap_heap_malloc(n);
}

void free(void *p)
{
    if (!heap_ready) {
        return;
    }
    webmap_heap_free(p);
}

void *calloc(size_t nmemb, size_t size)
{
    ensure_heap();
    return webmap_heap_calloc(nmemb, size);
}

void *realloc(void *ptr, size_t size)
{
    ensure_heap();
    return webmap_heap_realloc(ptr, size);
}

/* Explicit exports for host staging / reload policy (ADR-024 / P4.3). */
__attribute__((export_name("webmap_wasm_alloc")))
void *webmap_wasm_alloc(size_t n)
{
    return malloc(n);
}

__attribute__((export_name("webmap_wasm_free")))
void webmap_wasm_free(void *p)
{
    free(p);
}

__attribute__((export_name("webmap_wasm_reset_arena")))
void webmap_wasm_reset_arena(void)
{
    ensure_heap();
    webmap_heap_reset_arena();
}

__attribute__((export_name("webmap_wasm_heap_used")))
size_t webmap_wasm_heap_used(void)
{
    webmap_heap_stats_t s;
    ensure_heap();
    webmap_heap_get_stats(&s);
    return s.used_bytes;
}

__attribute__((export_name("webmap_wasm_heap_free_bytes")))
size_t webmap_wasm_heap_free_bytes(void)
{
    webmap_heap_stats_t s;
    ensure_heap();
    webmap_heap_get_stats(&s);
    return s.free_bytes;
}

__attribute__((export_name("webmap_wasm_heap_capacity")))
size_t webmap_wasm_heap_capacity(void)
{
    webmap_heap_stats_t s;
    ensure_heap();
    webmap_heap_get_stats(&s);
    return s.capacity_bytes;
}

__attribute__((export_name("webmap_wasm_heap_over_watermark")))
int webmap_wasm_heap_over_watermark(void)
{
    ensure_heap();
    return webmap_heap_over_watermark();
}

__attribute__((export_name("webmap_wasm_heap_set_watermark")))
void webmap_wasm_heap_set_watermark(size_t bytes)
{
    ensure_heap();
    webmap_heap_set_watermark(bytes);
}

__attribute__((export_name("webmap_wasm_heap_high_water")))
size_t webmap_wasm_heap_high_water(void)
{
    webmap_heap_stats_t s;
    ensure_heap();
    webmap_heap_get_stats(&s);
    return s.high_water;
}

void *memcpy(void *dst, const void *src, size_t n)
{
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    size_t i;
    for (i = 0; i < n; i++) {
        d[i] = s[i];
    }
    return dst;
}

void *memset(void *dst, int c, size_t n)
{
    unsigned char *d = (unsigned char *)dst;
    size_t i;
    for (i = 0; i < n; i++) {
        d[i] = (unsigned char)c;
    }
    return dst;
}

void *memmove(void *dst, const void *src, size_t n)
{
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    size_t i;
    if (d < s) {
        for (i = 0; i < n; i++) {
            d[i] = s[i];
        }
    } else if (d > s) {
        for (i = n; i > 0; i--) {
            d[i - 1] = s[i - 1];
        }
    }
    return dst;
}

size_t strlen(const char *s)
{
    size_t n = 0;
    if (!s) {
        return 0;
    }
    while (s[n]) {
        n++;
    }
    return n;
}

int strcmp(const char *a, const char *b)
{
    if (!a || !b) {
        return (int)(a != b);
    }
    while (*a && *a == *b) {
        a++;
        b++;
    }
    return (unsigned char)*a - (unsigned char)*b;
}

char *strstr(const char *hay, const char *needle)
{
    size_t n, i;
    if (!hay || !needle) {
        return NULL;
    }
    if (!*needle) {
        return (char *)hay;
    }
    n = strlen(needle);
    for (i = 0; hay[i]; i++) {
        size_t j = 0;
        while (j < n && hay[i + j] == needle[j]) {
            j++;
        }
        if (j == n) {
            return (char *)(hay + i);
        }
    }
    return NULL;
}

/* ── Soft math (projection needs) ──────────────────────────────────── */

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

double fabs(double x)
{
    return x < 0 ? -x : x;
}

double floor(double x)
{
    double i = (double)(long long)x;
    if (x >= 0 || i == x) {
        return i;
    }
    return i - 1.0;
}

double exp(double x)
{
    int k;
    double y, s, t;
    if (x > 88.0) {
        return 1e38;
    }
    if (x < -88.0) {
        return 0.0;
    }
    {
        double n = floor(x / 0.6931471805599453 + 0.5);
        double r = x - n * 0.6931471805599453;
        s = 1.0;
        t = 1.0;
        for (k = 1; k < 12; k++) {
            t *= r / (double)k;
            s += t;
        }
        y = s;
        if (n > 0) {
            while (n-- > 0) {
                y *= 2.0;
            }
        } else {
            while (n++ < 0) {
                y *= 0.5;
            }
        }
        return y;
    }
}

double log(double x)
{
    int n = 0;
    double y, z, s;
    int k;
    if (x <= 0.0) {
        return -1e38;
    }
    while (x > 1.5) {
        x *= 0.5;
        n++;
    }
    while (x < 0.75) {
        x *= 2.0;
        n--;
    }
    z = x - 1.0;
    s = 0.0;
    y = z;
    for (k = 1; k < 20; k++) {
        s += ((k & 1) ? y : -y) / (double)k;
        y *= z;
    }
    return s + n * 0.6931471805599453;
}

double sin(double x)
{
    const double twopi = 6.283185307179586;
    double s, t;
    int k;
    while (x > 3.141592653589793) {
        x -= twopi;
    }
    while (x < -3.141592653589793) {
        x += twopi;
    }
    s = 0.0;
    t = x;
    for (k = 1; k < 12; k++) {
        s += t;
        t *= -x * x / ((2.0 * k) * (2.0 * k + 1.0));
    }
    return s;
}

double cos(double x)
{
    return sin(x + 1.5707963267948966);
}

double tan(double x)
{
    double c = cos(x);
    if (c == 0.0) {
        return 1e38;
    }
    return sin(x) / c;
}

double atan(double x)
{
    int inv = 0;
    double s, t, x2;
    int k;
    if (x > 1.0) {
        x = 1.0 / x;
        inv = 1;
    } else if (x < -1.0) {
        x = 1.0 / x;
        inv = -1;
    }
    x2 = x * x;
    s = 0.0;
    t = x;
    for (k = 0; k < 16; k++) {
        s += ((k & 1) ? -t : t) / (double)(2 * k + 1);
        t *= x2;
    }
    if (inv == 1) {
        return 1.5707963267948966 - s;
    }
    if (inv == -1) {
        return -1.5707963267948966 - s;
    }
    return s;
}

double sinh(double x)
{
    double e = exp(x);
    double ei = exp(-x);
    return 0.5 * (e - ei);
}
