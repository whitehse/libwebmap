cmake_minimum_required(VERSION 3.20)
project(libwebmap VERSION 0.1.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

option(WEBMAP_BUILD_TOOLS "Build host utilities (gfvtile2wmap, fiber2features, splice_diagram)" ON)
option(WEBMAP_BUILD_TESTS "Build unit tests" ON)
option(WEBMAP_BUILD_WASM "Build freestanding WASM module (clang, no Emscripten)" OFF)
option(WEBMAP_BUILD_FUZZ "Build libFuzzer harness" OFF)
option(WEBMAP_BUILD_DEMO "Copy WebGPU demo assets into build/demo" ON)

# Optional fiber design DB for generating splice HTML into demo/splice_diagrams/
set(FIBER_DESIGN_DB "" CACHE FILEPATH
    "Normalized fiber design SQLite (Tier A). When set, enables splice_diagrams target.")
set(SPLICE_DIAGRAMS_OUT "${CMAKE_SOURCE_DIR}/demo/splice_diagrams" CACHE PATH
    "Output directory for generated HTML splice diagrams (real dir, not symlink).")
set(SPLICE_DIAGRAMS_LIMIT "0" CACHE STRING
    "Max diagrams to generate (0 = all). Useful for smoke tests.")

if(NOT MSVC)
    add_compile_options(-Wall -Wextra -Wpedantic -Werror)
endif()

# ── Core static library (host / native only) ─────────────────────────
if(NOT WEBMAP_BUILD_WASM)
    add_library(webmap STATIC
        src/webmap.c
        src/webmap_mvt.c
    )
    target_include_directories(webmap PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
    )
    target_link_libraries(webmap PUBLIC m)
endif()

# ── Host tools (not linked into WASM) ────────────────────────────────
if(WEBMAP_BUILD_TOOLS AND NOT WEBMAP_BUILD_WASM)
    add_executable(gfvtile2wmap tools/gfvtile2wmap/main.c)
    target_link_libraries(gfvtile2wmap PRIVATE webmap)

    # Shared vendored SQLite amalgamation for host tools (not WASM).
    set(WEBMAP_SQLITE_SRC tools/third_party/sqlite/sqlite3.c)
    set_source_files_properties(${WEBMAP_SQLITE_SRC} PROPERTIES
        COMPILE_OPTIONS "-w"
    )

    # fiber2features: design DB → .fmap package (vendored SQLite amalgamation)
    add_executable(fiber2features
        tools/fiber2features/fiber2features.c
        tools/fiber2features/schema_map_sql.c
        ${WEBMAP_SQLITE_SRC}
    )
    target_include_directories(fiber2features PRIVATE
        tools/third_party/sqlite
    )
    # Amalgamation uses a few POSIX bits; fiber2features is host-only.
    target_compile_definitions(fiber2features PRIVATE
        SQLITE_THREADSAFE=0
        SQLITE_OMIT_LOAD_EXTENSION=1
    )
    target_link_libraries(fiber2features PRIVATE m)
    # fiber2features.c enables _POSIX_C_SOURCE; relax pedantic for that TU only
    set_source_files_properties(tools/fiber2features/fiber2features.c PROPERTIES
        COMPILE_OPTIONS "-Wno-pedantic"
    )

    # splice_diagram: design DB → self-contained HTML per splicepoint
    add_executable(splice_diagram
        tools/splice_diagram/splice_diagram.c
        tools/splice_diagram/splice_diagram_cli.c
        ${WEBMAP_SQLITE_SRC}
    )
    target_include_directories(splice_diagram PRIVATE
        tools/third_party/sqlite
        tools/splice_diagram
    )
    target_compile_definitions(splice_diagram PRIVATE
        SQLITE_THREADSAFE=0
        SQLITE_OMIT_LOAD_EXTENSION=1
    )
    target_link_libraries(splice_diagram PRIVATE m)
    # strcasecmp / strings.h (POSIX); host-only tool
    set_source_files_properties(
        tools/splice_diagram/splice_diagram.c
        tools/splice_diagram/splice_diagram_cli.c
        PROPERTIES COMPILE_OPTIONS "-Wno-pedantic"
    )

    # Generate real demo/splice_diagrams/ content (not a symlink).
    # Requires -DFIBER_DESIGN_DB=/path/to/fiber_design.sqlite
    add_custom_target(splice_diagrams
        COMMAND ${CMAKE_COMMAND}
            -DFIBER_DESIGN_DB=${FIBER_DESIGN_DB}
            -DSPLICE_DIAGRAMS_OUT=${SPLICE_DIAGRAMS_OUT}
            -DSPLICE_DIAGRAMS_LIMIT=${SPLICE_DIAGRAMS_LIMIT}
            -DSPLICE_DIAGRAM_BIN=$<TARGET_FILE:splice_diagram>
            -P ${CMAKE_SOURCE_DIR}/cmake/GenerateSpliceDiagrams.cmake
        DEPENDS splice_diagram
        COMMENT "Generate HTML splice diagrams → ${SPLICE_DIAGRAMS_OUT}"
        VERBATIM
    )
endif()

# ── Tests ────────────────────────────────────────────────────────────
if(WEBMAP_BUILD_TESTS AND NOT WEBMAP_BUILD_WASM)
    enable_testing()

    add_executable(webmap_smoke tests/test_webmap_smoke.c)
    target_link_libraries(webmap_smoke PRIVATE webmap)
    add_test(NAME webmap_smoke COMMAND webmap_smoke)

    add_executable(webmap_mvt_smoke tests/test_mvt_smoke.c)
    target_link_libraries(webmap_mvt_smoke PRIVATE webmap)
    add_test(NAME webmap_mvt_smoke COMMAND webmap_mvt_smoke)

    add_executable(webmap_wmap_roundtrip tests/test_wmap_roundtrip.c)
    target_link_libraries(webmap_wmap_roundtrip PRIVATE webmap)
    add_test(NAME webmap_wmap_roundtrip COMMAND webmap_wmap_roundtrip)

    add_executable(webmap_frustum tests/test_frustum.c)
    target_link_libraries(webmap_frustum PRIVATE webmap)
    add_test(NAME webmap_frustum COMMAND webmap_frustum)

    add_executable(webmap_polygon tests/test_polygon_fill.c)
    target_link_libraries(webmap_polygon PRIVATE webmap)
    add_test(NAME webmap_polygon COMMAND webmap_polygon)

    add_executable(webmap_fixture_ok tests/test_fixture_oklahoma.c)
    target_link_libraries(webmap_fixture_ok PRIVATE webmap)
    add_test(NAME webmap_fixture_ok COMMAND webmap_fixture_ok
             WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})

    # .fmap v2/v3 golden fixtures (Python; no extra deps)
    add_test(NAME webmap_fmap_parse
             COMMAND python3 ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_fmap_parse.py
             WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})

    # path_index exporter self-test (synthetic design DB)
    add_test(NAME webmap_path_index
             COMMAND python3 ${CMAKE_CURRENT_SOURCE_DIR}/tools/export_path_index.py --self-test
             WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
endif()

# ── Freestanding WASM module (ADR-009, ADR-010) ──────────────────────
if(WEBMAP_BUILD_WASM)
    add_executable(webmap_wasm
        wasm/webmap_wasm_entry.c
        wasm/webmap_wasm_rt.c
        src/webmap.c
    )
    target_include_directories(webmap_wasm PRIVATE include)
    target_compile_definitions(webmap_wasm PRIVATE WEBMAP_WASM_FREESTANDING=1)
    target_compile_options(webmap_wasm PRIVATE
        -ffreestanding -fno-builtin -fno-exceptions
    )
    target_link_options(webmap_wasm PRIVATE
        -nostdlib
        -Wl,--no-entry
        -Wl,--export-dynamic
        -Wl,--allow-undefined
        -Wl,--import-memory
    )
    set_target_properties(webmap_wasm PROPERTIES
        OUTPUT_NAME "webmap"
        SUFFIX ".wasm"
    )
endif()

# ── Demo assets ──────────────────────────────────────────────────────
if(WEBMAP_BUILD_DEMO AND NOT WEBMAP_BUILD_WASM)
    # Copy demo sources into build/demo, but do not re-copy multi-GB regenerable
    # trees (splice_diagrams, fiber_data bulk). Symlink those when present so
    # `python3 -m http.server -d build/demo` still resolves diagrams_url.
    set(_WEBMAP_DEMO_DST ${CMAKE_BINARY_DIR}/demo)
    set(_WEBMAP_DEMO_SRC ${CMAKE_SOURCE_DIR}/demo)
    add_custom_target(webmap_demo ALL
        COMMAND ${CMAKE_COMMAND} -E make_directory ${_WEBMAP_DEMO_DST}
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                ${_WEBMAP_DEMO_SRC}/index.html ${_WEBMAP_DEMO_DST}/index.html
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                ${_WEBMAP_DEMO_SRC}/main.js ${_WEBMAP_DEMO_DST}/main.js
        COMMAND ${CMAKE_COMMAND} -E copy_directory
                ${_WEBMAP_DEMO_SRC}/display ${_WEBMAP_DEMO_DST}/display
        COMMAND ${CMAKE_COMMAND}
            -DDEMO_SRC=${_WEBMAP_DEMO_SRC}
            -DDEMO_DST=${_WEBMAP_DEMO_DST}
            -P ${CMAKE_SOURCE_DIR}/cmake/LinkDemoData.cmake
        COMMENT "Stage WebGPU demo into build/demo"
        VERBATIM
    )
endif()

# ── Fuzz (optional) ──────────────────────────────────────────────────
if(WEBMAP_BUILD_FUZZ)
    add_executable(webmap_fuzz fuzz/webmap_fuzz.c)
    target_link_libraries(webmap_fuzz PRIVATE webmap)
    target_compile_options(webmap_fuzz PRIVATE -fsanitize=fuzzer,address,undefined)
    target_link_options(webmap_fuzz PRIVATE -fsanitize=fuzzer,address,undefined)
endif()

include(GNUInstallDirs)
if(TARGET webmap)
    install(TARGETS webmap ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR})
    install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
endif()
if(TARGET gfvtile2wmap)
    install(TARGETS gfvtile2wmap RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()
if(TARGET fiber2features)
    install(TARGETS fiber2features RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
    install(FILES tools/schema/schema_map.sql
            DESTINATION ${CMAKE_INSTALL_DATADIR}/webmap)
endif()
if(TARGET splice_diagram)
    install(TARGETS splice_diagram RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()
if(TARGET webmap_wasm)
    install(TARGETS webmap_wasm DESTINATION ${CMAKE_INSTALL_LIBDIR})
endif()
