cmake_minimum_required(VERSION 3.20)

project(mhr_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(mhr_native SHARED
  src/mhr_native_api.cpp
  src/mhr_runtime.cpp
)

target_include_directories(mhr_native
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
  PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

if(MSVC)
  target_compile_options(mhr_native PRIVATE /W4 /EHsc)
else()
  target_compile_options(mhr_native PRIVATE -Wall -Wextra -Wpedantic)
endif()
