cmake_minimum_required(VERSION 3.16)
project(aqara_streamer CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Optimization flags
if(MSVC)
    add_compile_options(/O2 /W4)
else()
    add_compile_options(-O3 -Wall -Wextra -Wpedantic -pthread)
endif()

include(FetchContent)
FetchContent_Declare(
    glaze
    GIT_REPOSITORY https://github.com/stephenberry/glaze.git
    GIT_TAG v4.4.2
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(glaze)

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
target_link_libraries(aqara-streamer PRIVATE glaze::glaze pthread)

enable_testing()
add_executable(aqara-reassembler-test
    tests/reassembler_test.cpp
    src/crypto/chacha20.cpp
    src/media/reassembler.cpp
)
target_link_libraries(aqara-reassembler-test PRIVATE pthread)
add_test(NAME aqara-reassembler-test COMMAND aqara-reassembler-test)
