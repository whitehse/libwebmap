# WasmToolchain.cmake — clang/wasm-ld freestanding WASM, no Emscripten (ADR-009).
#
# Usage:
#   cmake -B build-wasm -S . \
#     -DCMAKE_TOOLCHAIN_FILE=cmake/WasmToolchain.cmake \
#     -DWEBMAP_BUILD_WASM=ON
#
# Requires: clang with wasm32 target, wasm-ld (lld).

set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

# Prefer versioned clang when bare `clang` is not on PATH (common on Debian/Ubuntu).
if(NOT DEFINED CMAKE_C_COMPILER OR CMAKE_C_COMPILER STREQUAL "clang")
    find_program(_WEBMAP_CLANG NAMES clang clang-19 clang-18 clang-17 clang-16)
    if(_WEBMAP_CLANG)
        set(CMAKE_C_COMPILER "${_WEBMAP_CLANG}")
    else()
        set(CMAKE_C_COMPILER clang)
    endif()
endif()
if(NOT DEFINED CMAKE_CXX_COMPILER OR CMAKE_CXX_COMPILER STREQUAL "clang++")
    find_program(_WEBMAP_CLANGXX NAMES clang++ clang++-19 clang++-18 clang++-17 clang++-16)
    if(_WEBMAP_CLANGXX)
        set(CMAKE_CXX_COMPILER "${_WEBMAP_CLANGXX}")
    else()
        set(CMAKE_CXX_COMPILER clang++)
    endif()
endif()
set(CMAKE_ASM_COMPILER "${CMAKE_C_COMPILER}")

set(CMAKE_C_COMPILER_TARGET wasm32)
set(CMAKE_CXX_COMPILER_TARGET wasm32)

set(CMAKE_C_FLAGS_INIT "-target wasm32 -ffreestanding -fno-builtin")
set(CMAKE_EXE_LINKER_FLAGS_INIT
    "-target wasm32 -nostdlib -Wl,--no-entry -Wl,--export-dynamic -Wl,--allow-undefined")

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

# Avoid try-compile host executables.
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
