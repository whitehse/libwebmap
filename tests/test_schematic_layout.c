/**
 * P4.10: webmap_schematic_layout unit test (native).
 */
#include "webmap_schematic.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fails;

static int near_f(float a, float b, float eps)
{
    return fabsf(a - b) < eps;
}

static void expect(int cond, const char *msg)
{
    if (!cond) {
        fprintf(stderr, "FAIL: %s\n", msg);
        fails++;
    } else {
        printf("ok: %s\n", msg);
    }
}

static uint8_t *read_file(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    long sz;
    uint8_t *buf;
    if (!f) {
        return NULL;
    }
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return NULL;
    }
    sz = ftell(f);
    if (sz < 0) {
        fclose(f);
        return NULL;
    }
    rewind(f);
    buf = (uint8_t *)malloc((size_t)sz + 1);
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
    buf[sz] = 0;
    if (out_len) {
        *out_len = (size_t)sz;
    }
    return buf;
}

static void test_snap_unit(void)
{
    float ux, uy;
    expect(webmap_schematic_snap_deg45(0.f) == 0.f, "snap 0");
    expect(webmap_schematic_snap_deg45(44.f) == 45.f, "snap 44→45");
    expect(webmap_schematic_snap_deg45(88.f) == 90.f, "snap 88→90");
    expect(webmap_schematic_snap_deg45(264.3f) == 270.f, "snap 264.3→270");
    webmap_schematic_approach_unit(0.f, &ux, &uy);
    expect(near_f(ux, 0.f, 1e-5f) && uy < -0.99f, "N unit (0° → −y)");
    webmap_schematic_approach_unit(90.f, &ux, &uy);
    expect(ux > 0.99f && near_f(uy, 0.f, 1e-5f), "E unit (90° → +x)");
}

static void test_minimal_json(void)
{
    static const char *json =
        "{"
        "\"v\":2,"
        "\"kind\":\"splice\","
        "\"cables\":["
        "{\"guid\":\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\",\"size\":12,"
        "\"is_drop\":false,\"approach_deg\":90},"
        "{\"guid\":\"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\",\"size\":12,"
        "\"is_drop\":false,\"approach_deg\":270}"
        "],"
        "\"links\":["
        "{\"role\":\"fuse\","
        "\"a\":{\"cable\":\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\",\"fiber\":1},"
        "\"b\":{\"cable\":\"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\",\"fiber\":1}"
        "}"
        "]"
        "}";
    uint8_t out[8192];
    size_t n = webmap_schematic_layout((const uint8_t *)json, strlen(json), 0.f,
                                       0.f, 100.f, out, sizeof(out));
    const webmap_schematic_header_t *hdr =
        (const webmap_schematic_header_t *)out;
    expect(n > 0, "minimal layout bytes");
    expect(n == webmap_schematic_blob_size(hdr->n_cables, hdr->n_fibers,
                                          hdr->n_fuses),
           "blob size matches header");
    expect(hdr->magic == WEBMAP_SCHEMATIC_MAGIC, "magic WSCH");
    expect(hdr->version == WEBMAP_SCHEMATIC_VERSION, "version 1");
    expect(hdr->n_cables == 2, "2 cables");
    expect(hdr->n_fibers == 2, "2 fiber chips");
    expect(hdr->n_fuses == 1, "1 fuse bridge");
    {
        const webmap_schematic_cable_t *cabs =
            (const webmap_schematic_cable_t *)(out + sizeof(*hdr));
        expect(cabs[0].approach_deg == 90.f, "cable0 true E");
        expect(cabs[1].approach_deg == 270.f, "cable1 true W");
        expect(cabs[0].x > 0.f, "E hub +x");
        expect(cabs[1].x < 0.f, "W hub −x");
    }
}

static void test_true_approach_angle(void)
{
    /* 32° must not snap to 45° — glass should match plant bearing. */
    static const char *json =
        "{"
        "\"v\":2,"
        "\"kind\":\"splice\","
        "\"cables\":["
        "{\"guid\":\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\",\"size\":12,"
        "\"is_drop\":false,\"approach_deg\":32},"
        "{\"guid\":\"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\",\"size\":12,"
        "\"is_drop\":false,\"approach_deg\":200}"
        "],"
        "\"links\":[]"
        "}";
    uint8_t out[8192];
    size_t n = webmap_schematic_layout((const uint8_t *)json, strlen(json), 0.f,
                                       0.f, 100.f, out, sizeof(out));
    const webmap_schematic_header_t *hdr =
        (const webmap_schematic_header_t *)out;
    expect(n > 0, "true-angle layout bytes");
    expect(hdr->n_cables == 2, "2 cables at true angles");
    {
        const webmap_schematic_cable_t *cabs =
            (const webmap_schematic_cable_t *)(out + sizeof(*hdr));
        expect(near_f(cabs[0].approach_deg, 32.f, 0.05f), "cable0 stays 32°");
        expect(near_f(cabs[1].approach_deg, 200.f, 0.05f), "cable1 stays 200°");
    }
}

static void test_fixture(void)
{
    size_t len = 0;
    uint8_t *json =
        read_file("fixtures/schematic/sample_tap.json", &len);
    uint8_t out[65536];
    size_t n;
    const webmap_schematic_header_t *hdr;
    expect(json != NULL && len > 0, "read sample_tap.json");
    if (!json) {
        return;
    }
    n = webmap_schematic_layout(json, len, 0.f, 0.f, 168.f, out, sizeof(out));
    free(json);
    expect(n > 0, "fixture layout ok");
    hdr = (const webmap_schematic_header_t *)out;
    expect(hdr->n_cables == 3, "fixture 3 cables");
    expect(hdr->n_fibers > 0, "fixture fibers");
    expect(hdr->n_fuses > 0, "fixture fuses");
    expect((hdr->flags & 1u) != 0, "fixture marked tap");
    printf("  fixture: cables=%u fibers=%u fuses=%u bytes=%zu\n",
           (unsigned)hdr->n_cables, (unsigned)hdr->n_fibers,
           (unsigned)hdr->n_fuses, n);
}

static void test_bad(void)
{
    uint8_t out[256];
    expect(webmap_schematic_layout((const uint8_t *)"{}", 2, 0, 0, 100, out,
                                   sizeof(out)) == 0,
           "empty object fails");
    expect(webmap_schematic_layout((const uint8_t *)"not json", 8, 0, 0, 100,
                                   out, sizeof(out)) == 0,
           "garbage fails");
}

int main(void)
{
    test_snap_unit();
    test_minimal_json();
    test_true_approach_angle();
    test_fixture();
    test_bad();
    if (fails) {
        fprintf(stderr, "%d failure(s)\n", fails);
        return 1;
    }
    printf("all schematic_layout tests passed\n");
    return 0;
}
