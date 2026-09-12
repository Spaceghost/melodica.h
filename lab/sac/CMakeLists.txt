cmake_minimum_required(VERSION 3.3)
project(melodica-sac-probation C)

set(DLL_BUILD_DIR "${PROJECT_BINARY_DIR}/lib")
set(TARGET "seq" CACHE STRING "SaC target")
set(SAC2C_EXEC "" CACHE FILEPATH "Path to sac2c")
set(LINKSETSIZE "0")
set(CMAKE_COMMON_DIR "cmake-common")

include("${CMAKE_SOURCE_DIR}/${CMAKE_COMMON_DIR}/check-sac2c.cmake")
include("${CMAKE_SOURCE_DIR}/${CMAKE_COMMON_DIR}/misc-macros.cmake")

set(SAC2C_DEF_FLAGS -v0 -O3 -maxlur 3 -linksetsize ${LINKSETSIZE}
    -L ${DLL_BUILD_DIR} -T ${DLL_BUILD_DIR})

include("${CMAKE_SOURCE_DIR}/${CMAKE_COMMON_DIR}/sac2c-variables.cmake")
include("${CMAKE_SOURCE_DIR}/${CMAKE_COMMON_DIR}/check-sac4c.cmake")
include("${CMAKE_SOURCE_DIR}/${CMAKE_COMMON_DIR}/resolve-sac2c-dependencies.cmake")
include("${CMAKE_SOURCE_DIR}/${CMAKE_COMMON_DIR}/build-sac2c-module.cmake")

file(MAKE_DIRECTORY "${DLL_BUILD_DIR}/${TARGET_ENV}/${SBI}")

set(SAC_MOD_SRC FindString.sac)
SAC2C_COMPILE_MOD(FindString.sac "${SAC_MOD_SRC}" "${SAC2C_DEF_FLAGS}")

set(SAC4C ${SAC4C_EXEC} -nophm -target ${TARGET}
    -L ${DLL_BUILD_DIR} -T ${DLL_BUILD_DIR})
set(WRAPPER_NAME "sacwrapper-FindString")
set(WRAPPER_SO
    "${CMAKE_CURRENT_BINARY_DIR}/${WRAPPER_NAME}/${TARGET_ENV}/${SBI}/lib${WRAPPER_NAME}${MODEXT}")
set(WRAPPER_H "${CMAKE_CURRENT_BINARY_DIR}/${WRAPPER_NAME}.h")

add_custom_command(
    OUTPUT ${WRAPPER_SO} ${WRAPPER_H}
    COMMAND ${SAC4C} FindString -o ${WRAPPER_NAME}
    WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}
    DEPENDS ${mod} ${tree}
    COMMENT "Generating C wrapper for FindString")

add_custom_target(sac-wrapper ALL DEPENDS ${WRAPPER_SO} ${WRAPPER_H})
