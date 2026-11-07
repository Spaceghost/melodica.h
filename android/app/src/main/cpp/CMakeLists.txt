cmake_minimum_required(VERSION 3.10)
project(melodica C)

set(MELODICA_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../vendor/melodica")
add_library(melodica SHARED "${MELODICA_ROOT}/impl/c/melodica.c")
target_include_directories(melodica PRIVATE "${MELODICA_ROOT}/include")
target_compile_options(melodica PRIVATE -O3 -Wall -Wextra)
