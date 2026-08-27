cmake_minimum_required(VERSION 3.15)
project(aqara_media_core CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|AppleClang|GNU")
    add_compile_options(-O3 -Wall -Wextra -pthread)
endif()

include_directories(src)

add_executable(aqara-media-core
    src/main.cpp
)

target_link_libraries(aqara-media-core PRIVATE pthread)

add_executable(test_media_core
    tests/test_main.cpp
)

target_link_libraries(test_media_core PRIVATE pthread)
