/**
 * @file webmap_wasm_rt.c
 * @brief Freestanding WASM runtime: heap + libc/math shims (no Emscripten).
 *
 * Memory model: linear memory grows via __builtin_wasm_memory_grow.
 * Host may still import nothing for malloc — this file is self-contained.
 *
 * Build: clang --target=wasm32 -nostdlib -ffreestanding …
 * Documented in docs/decisions/010 and docs/guides/wasm.md
 */

#include <stddef.h>
#include <stdint.h>

/* ── Memory ────────────────────────────────────────────────────────── */

/* Bump heap starts at 1 page (64 KiB) so low memory stays free for data. */
static uintptr_t heap_ptr = 65536u;
static int heap_inited;

static void heap_init(void)
{
    if (!heap_inited) {
        heap_ptr = (heap_ptr + 15u) & ~(uintptr_t)15u;
        heap_inited = 1;
    }
}

void *malloc(size_t n)
{
    uintptr_t p, end, pages, need;
    heap_init();
    if (n == 0) {
        n = 1;
    }
    n = (n + 15u) & ~(size_t)15u;
    p = heap_ptr;
    end = p + n;
    /* grow memory if needed (page = 64 KiB) */
    pages = __builtin_wasm_memory_size(0);
    need = (end + 65535u) / 65536u;
    if (need > pages) {
        if (__builtin_wasm_memory_grow(0, need - pages) == (size_t)-1) {
            return NULL;
        }
    }
    heap_ptr = end;
    return (void *)p;
}

void free(void *p)
{
    (void)p; /* bump allocator: no free */
}

void *calloc(size_t nmemb, size_t size)
{
    size_t n;
    void *p;
    unsigned char *b;
    size_t i;
    if (size != 0 && nmemb > (size_t)-1 / size) {
        return NULL;
    }
    n = nmemb * size;
    p = malloc(n);
    if (!p) {
        return NULL;
    }
    b = (unsigned char *)p;
    for (i = 0; i < n; i++) {
        b[i] = 0;
    }
    return p;
}

void *realloc(void *ptr, size_t size)
{
    void *n;
    /* bump allocator cannot shrink old block; copy */
    if (!ptr) {
        return malloc(size);
    }
    n = malloc(size);
    if (!n) {
        return NULL;
    }
    /* best-effort copy of size bytes (may over-read old; acceptable for wasm) */
    {
        unsigned char *d = (unsigned char *)n;
        const unsigned char *s = (const unsigned char *)ptr;
        size_t i;
        for (i = 0; i < size; i++) {
            d[i] = s[i];
        }
    }
    return n;
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

/* Cody-Waite style approximations adequate for map projection. */

double exp(double x)
{
    /* series for |x| moderate */
    int k;
    double y, s, t;
    if (x > 88.0) {
        return 1e38;
    }
    if (x < -88.0) {
        return 0.0;
    }
    /* reduce: exp(x) = 2^n * exp(r) */
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
    /* log(1+z) series, z = x-1 */
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
    /* range reduce to [-pi,pi] roughly */
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
    /* atan via series for |x|<=1, identity otherwise */
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
