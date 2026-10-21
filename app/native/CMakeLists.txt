cmake_minimum_required(VERSION 3.16)
project(aqara_streamer CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Optimization flags
if(MSVC)
    add_compile_options(/O2 /W4)
else()
    add_compile_options(-O3 -Wall -Wextra -Wpedantic -pthread)
endif()

include(FetchContent)
FetchContent_Declare(
    glaze
    URL https://github.com/stephenberry/glaze/archive/refs/tags/v4.4.2.tar.gz
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(glaze)

include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${glaze_SOURCE_DIR}/include
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
    src/p2p/cipher.cpp
)
target_link_libraries(aqara-reassembler-test PRIVATE pthread)
add_test(NAME aqara-reassembler-test COMMAND aqara-reassembler-test)

add_executable(aqara-rtp-timeline-test tests/rtp_timeline_test.cpp)
add_test(NAME aqara-rtp-timeline-test COMMAND aqara-rtp-timeline-test)

add_executable(aqara-frame-watchdog-test tests/frame_watchdog_test.cpp)
add_test(NAME aqara-frame-watchdog-test COMMAND aqara-frame-watchdog-test)

add_executable(aqara-rtsp-writer-test tests/rtsp_writer_test.cpp)
target_link_libraries(aqara-rtsp-writer-test PRIVATE pthread)
add_test(NAME aqara-rtsp-writer-test COMMAND aqara-rtsp-writer-test)

add_executable(aqara-rtsp-server-test tests/rtsp_server_test.cpp src/rtsp/server.cpp)
target_link_libraries(aqara-rtsp-server-test PRIVATE pthread)
add_test(NAME aqara-rtsp-server-test COMMAND aqara-rtsp-server-test)
