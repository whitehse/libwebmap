# Fiber path-trace fixtures

Golden `.fmap` samples for format regression (ADR path-trace plan PR6).

| File | Version | Notes |
|------|---------|-------|
| `sample_v2.fmap` | 2 | Lines **without** `cable_guid` (legacy) |
| `sample_v3.fmap` | 3 | Same geometry; cable/drop lines carry known GUIDs |

Known plant GUIDs in v3:

| Feature | GUID |
|---------|------|
| cable | `aabbccdd-1122-3344-5566-77889900aabb` |
| drop | `00112233-4455-6677-8899-aabbccddeeff` |

Parse smoke: `python3 tests/test_fmap_parse.py`  
Layout: [docs/formats/fmap.md](../../docs/formats/fmap.md)
