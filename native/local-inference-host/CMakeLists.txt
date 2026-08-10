cmake_minimum_required(VERSION 3.20)
project(twinscript_local_inference LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(TWINSCRIPT_OPENVINO_GENAI "Build the real OpenVINO GenAI Whisper adapter" OFF)

include(FetchContent)
FetchContent_Declare(
  nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
  URL_HASH SHA256=42f6e95cad6ec532fd372391373363b62a14af6d771056dbfc86160e6dfff7aa
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_Declare(
  Catch2
  URL https://github.com/catchorg/Catch2/archive/refs/tags/v3.8.1.tar.gz
  URL_HASH SHA256=18b3f70ac80fccc340d8c6ff0f339b2ae64944782f8d2fca2bd705cf47cadb79
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(nlohmann_json Catch2)

enable_testing()
add_library(local_inference_core
  src/audio_segmenter.cpp
  src/fake_engine.cpp
  src/json_line_transport.cpp
  src/protocol_server.cpp
  src/request_registry.cpp
)
target_include_directories(local_inference_core PUBLIC src)
target_link_libraries(local_inference_core PUBLIC nlohmann_json::nlohmann_json)

if(TWINSCRIPT_OPENVINO_GENAI)
  find_package(OpenVINOGenAI REQUIRED)
  target_sources(local_inference_core PRIVATE src/openvino_whisper_engine.cpp)
  target_sources(local_inference_core PRIVATE src/native_engines.cpp)
  target_link_libraries(local_inference_core PUBLIC openvino::genai)
  target_compile_definitions(local_inference_core PUBLIC TWINSCRIPT_OPENVINO_GENAI=1)

  add_executable(whisper_engine_smoke tests/whisper_engine_smoke.cpp)
  target_link_libraries(whisper_engine_smoke PRIVATE local_inference_core)
  add_test(NAME whisper_engine_smoke COMMAND whisper_engine_smoke)
endif()

add_executable(twinscript-local-inference src/main.cpp)
target_link_libraries(twinscript-local-inference PRIVATE local_inference_core)

add_executable(local_inference_tests
  tests/audio_segmenter_test.cpp
  tests/json_line_transport_test.cpp
  tests/protocol_server_test.cpp
  tests/request_registry_test.cpp
)
target_include_directories(local_inference_tests PRIVATE src)
target_link_libraries(local_inference_tests PRIVATE Catch2::Catch2WithMain local_inference_core)

include(CTest)
include(Catch)
catch_discover_tests(local_inference_tests)
