# Generate HTML splice diagrams into a real directory (not a symlink).
# Invoked by the splice_diagrams custom target.
#
# Required cache/vars (passed -D from CMakeLists):
#   FIBER_DESIGN_DB      path to fiber_design.sqlite
#   SPLICE_DIAGRAMS_OUT  output directory
#   SPLICE_DIAGRAM_BIN   path to splice_diagram executable
#   SPLICE_DIAGRAMS_LIMIT  max diagrams (0 = all)

if(NOT FIBER_DESIGN_DB OR FIBER_DESIGN_DB STREQUAL "")
  message(FATAL_ERROR
    "FIBER_DESIGN_DB is not set.\n"
    "  cmake -B build -S . -DFIBER_DESIGN_DB=/path/to/fiber_design.sqlite\n"
    "  cmake --build build --target splice_diagrams")
endif()

if(NOT EXISTS "${FIBER_DESIGN_DB}")
  message(FATAL_ERROR "FIBER_DESIGN_DB not found: ${FIBER_DESIGN_DB}")
endif()

if(NOT SPLICE_DIAGRAM_BIN OR NOT EXISTS "${SPLICE_DIAGRAM_BIN}")
  message(FATAL_ERROR "splice_diagram binary missing: ${SPLICE_DIAGRAM_BIN}")
endif()

if(NOT SPLICE_DIAGRAMS_OUT OR SPLICE_DIAGRAMS_OUT STREQUAL "")
  message(FATAL_ERROR "SPLICE_DIAGRAMS_OUT is empty")
endif()

# Refuse to write through a symlink: replace with a real directory.
if(EXISTS "${SPLICE_DIAGRAMS_OUT}" AND IS_SYMLINK "${SPLICE_DIAGRAMS_OUT}")
  message(STATUS "Removing symlink ${SPLICE_DIAGRAMS_OUT} (will create real directory)")
  file(REMOVE "${SPLICE_DIAGRAMS_OUT}")
endif()

file(MAKE_DIRECTORY "${SPLICE_DIAGRAMS_OUT}")

set(_args --all -o "${SPLICE_DIAGRAMS_OUT}" "${FIBER_DESIGN_DB}")
if(SPLICE_DIAGRAMS_LIMIT AND NOT SPLICE_DIAGRAMS_LIMIT STREQUAL "0")
  list(APPEND _args --limit "${SPLICE_DIAGRAMS_LIMIT}")
endif()

message(STATUS "splice_diagram → ${SPLICE_DIAGRAMS_OUT}")
message(STATUS "  db: ${FIBER_DESIGN_DB}")
if(SPLICE_DIAGRAMS_LIMIT AND NOT SPLICE_DIAGRAMS_LIMIT STREQUAL "0")
  message(STATUS "  limit: ${SPLICE_DIAGRAMS_LIMIT}")
endif()

execute_process(
  COMMAND "${SPLICE_DIAGRAM_BIN}" ${_args}
  RESULT_VARIABLE _rc
)
if(NOT _rc EQUAL 0)
  message(FATAL_ERROR "splice_diagram failed (exit ${_rc})")
endif()

message(STATUS "Done: ${SPLICE_DIAGRAMS_OUT}")
