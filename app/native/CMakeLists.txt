cmake_minimum_required(VERSION 3.16)
project(aqara_streamer CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Optimization flags
if(MSVC)
    add_compile_options(/O2 /W4)
else()
    add_compile_options(-O3 -Wall -Wextra -Wpedantic -pthread)
endif()

include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

set(SOURCES
    src/crypto/chacha20.cpp
    src/media/reassembler.cpp
    src/rtsp/server.cpp
    src/p2p/cipher.cpp
    src/p2p/client.cpp
    src/ipc/server.cpp
    src/session.cpp
    src/main.cpp
)

add_executable(aqara-streamer ${SOURCES})

target_link_libraries(aqara-streamer PRIVATE pthread)
