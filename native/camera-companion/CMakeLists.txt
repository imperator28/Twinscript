cmake_minimum_required(VERSION 3.20)
project(bilingual_camera_companion CXX)

# W4 native virtual-camera work. Windows x64 only: MFCreateVirtualCamera has a
# minimum supported client of Windows build 22000, and the companion is
# deliberately a separate process from Electron so a camera crash cannot take
# down a live caption session.
if(NOT WIN32)
  message(FATAL_ERROR "The camera companion is Windows-only.")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(MSVC)
  add_compile_options(/W4 /permissive- /EHsc)
  # UNICODE keeps the Win32 surface on the wide-character APIs the Media
  # Foundation headers expect.
  add_compile_definitions(UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

# Stage 0: feasibility probe. Reports whether this machine can host a native
# virtual camera before any media-source code is written.
add_executable(vcam_probe probe/main.cpp)
set_target_properties(vcam_probe PROPERTIES OUTPUT_NAME "vcam-probe")

# The shared-memory frame contract. Building this library is what executes the
# static_asserts in include/frame_transport.h; its JS counterpart is guarded by
# electron/captions/camera-frame-transport.test.cjs.
add_library(frame_transport_check STATIC src/frame_transport_check.cpp)
target_include_directories(frame_transport_check PUBLIC include)

# Executable protocol test for the real Windows mapped-region reader used by
# the Frame Server-hosted source.
add_executable(mapped_frame_reader_check
  src/mapped_frame_reader_check.cpp
  src/source/mapped_frame_reader.cpp
)
set_target_properties(mapped_frame_reader_check PROPERTIES OUTPUT_NAME "mapped-frame-reader-check")
target_include_directories(mapped_frame_reader_check PRIVATE include src/source)
target_link_libraries(mapped_frame_reader_check PRIVATE mfplat)

# The camera media source: a COM in-proc server Windows loads by CLSID when a
# consumer opens the camera.
add_library(vcam_source SHARED
  src/source/dll_main.cpp
  src/source/media_source.cpp
  src/source/media_source_activate.cpp
  src/source/media_stream.cpp
  src/source/mapped_frame_reader.cpp
  src/source/vcam_source.def
)
set_target_properties(vcam_source PROPERTIES OUTPUT_NAME "twinscript-vcam-source")
target_include_directories(vcam_source PRIVATE include src/source)
target_link_libraries(vcam_source PRIVATE mfplat mf mfuuid mfsensorgroup ole32 advapi32)

# The DirectShow camera: a second, independent COM in-proc server.
#
# Replaces the Media Foundation source above, which enumerates in every meeting
# client and streams to an in-process consumer but produces a black feed in Teams.
# Differential tracing against Microsoft's reference camera showed an identical
# call sequence and identical interfaces, and showed that the instance which
# actually delivers frames is not observable from either side - so that path could
# not be debugged further.
#
# DirectShow is proven on the target hardware: OBS Virtual Camera is a DirectShow
# filter, registered the same way, and it works in Teams on the machine where the
# MF camera is black. Clean-room implementation informed by that architecture;
# OBS is GPL-2.0 and none of its code is used here.
#
# strmiids carries CLSID_VideoInputDeviceCategory and CLSID_FilterMapper2.
add_library(dshow_camera SHARED
  src/dshow/dll_main.cpp
  src/dshow/dshow_filter.cpp
  src/dshow/dshow_registration.cpp
  src/dshow/twinscript_dshow.def
)
set_target_properties(dshow_camera PROPERTIES OUTPUT_NAME "twinscript-dshow-camera")
target_include_directories(dshow_camera PRIVATE include src/dshow)
target_link_libraries(dshow_camera PRIVATE strmiids ole32 oleaut32 uuid advapi32 shlwapi)

# Stage 1/2 harness: registers the source, drives it in-process, and creates the
# virtual camera. Kept separate from the DLL so a media-source bug can be
# reproduced without involving the Windows frame server.
add_executable(vcam_host src/host/main.cpp)
set_target_properties(vcam_host PROPERTIES OUTPUT_NAME "vcam-host")
target_include_directories(vcam_host PRIVATE include src/source)
target_link_libraries(vcam_host PRIVATE mfplat mf mfuuid mfreadwrite mfsensorgroup ole32 advapi32 shlwapi)
