// Verification harness for the virtual camera, in three stages.
//
//   vcam-host register     write the HKCU COM registration for the source DLL
//   vcam-host unregister   remove it
//   vcam-host drive        CoCreateInstance the source and pull frames directly
//   vcam-host camera       create the virtual camera and hold it open
//   vcam-host consume      open the camera as a consumer and read frames
//
// `drive` exists so a media-source defect can be found in this process, with a
// console and a debugger, instead of inside the Windows frame server where a
// failure is invisible. Only once `drive` passes is `camera` meaningful.

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <mfreadwrite.h>
#include <mfvirtualcamera.h>
#include <shlwapi.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "com_support.h"
#include "vcam_guids.h"

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mfsensorgroup.lib")
#pragma comment(lib, "ole32.lib")

using twinscript::vcam::ComPtr;
using twinscript::vcam::kCameraFriendlyName;
using twinscript::vcam::kMediaSourceClsid;
using twinscript::vcam::kMediaSourceClsidString;

namespace {

int Fail(const char* what, HRESULT hr) {
  std::printf("FAIL  %-34s 0x%08lX\n", what, static_cast<unsigned long>(hr));
  return 1;
}

void Ok(const char* what) { std::printf("ok    %s\n", what); }

// FNV-1a over the whole frame. Comparing a fixed prefix is not good enough: the
// test pattern's top-left corner is legitimately identical between most frames,
// so a prefix check reports a frozen feed that is not frozen (and would miss a
// feed that froze everywhere except the corner).
uint64_t HashFrame(const BYTE* data, size_t length) {
  uint64_t hash = 0xcbf29ce484222325ULL;
  for (size_t i = 0; i < length; ++i) {
    hash ^= data[i];
    hash *= 0x100000001b3ULL;
  }
  return hash;
}

// Read back the frame ordinal the source encodes as 16 blocks of 16x16 pixels
// along the top edge. Proves frames arrive in order, which a mere
// "bytes differ" check cannot.
//
// Works against either layout: the blocks are pure white or black, so in NV12
// the Y plane alone distinguishes them (235 vs 16).
uint32_t DecodeFrameIndex(const BYTE* data, uint32_t width, bool is_nv12) {
  uint32_t index = 0;
  for (uint32_t bit = 0; bit < 16; ++bit) {
    const uint32_t x = 8 + bit * 18 + 8;
    if ((bit + 1) * 18 >= width) break;
    const BYTE value =
        is_nv12 ? data[static_cast<size_t>(16) * width + x]
                : data[static_cast<size_t>(16) * width * 4 + static_cast<size_t>(x) * 4];
    if (value > 127) index |= (1u << bit);
  }
  return index;
}

std::wstring SourceDllPath() {
  wchar_t path[MAX_PATH] = {};
  ::GetModuleFileNameW(nullptr, path, MAX_PATH);
  ::PathRemoveFileSpecW(path);
  std::wstring dll(path);
  dll += L"\\twinscript-vcam-source.dll";
  return dll;
}

// Invoke the DLL's own registration entry point, so the registry layout lives in
// exactly one place (dll_main.cpp) rather than being duplicated here.
//
// `machine` selects HKLM, which the frame server requires and which needs
// administrator. Per-user registration only supports in-process activation.
int RunDllRegistration(bool add, bool machine) {
  const std::wstring dll = SourceDllPath();
  HMODULE module = ::LoadLibraryW(dll.c_str());
  if (!module) {
    std::printf("FAIL  LoadLibrary(%ls) win32=%lu\n", dll.c_str(), ::GetLastError());
    return 1;
  }
  using InstallFn = HRESULT(__stdcall*)(BOOL, LPCWSTR);
  auto install = reinterpret_cast<InstallFn>(::GetProcAddress(module, "DllInstall"));
  if (!install) {
    std::printf("FAIL  missing DllInstall export\n");
    ::FreeLibrary(module);
    return 1;
  }
  const HRESULT hr = install(add ? TRUE : FALSE, machine ? L"machine" : L"user");
  ::FreeLibrary(module);
  if (FAILED(hr)) {
    std::printf("FAIL  %s under %s: 0x%08lX%s\n", add ? "register" : "unregister",
                machine ? "HKLM" : "HKCU", static_cast<unsigned long>(hr),
                (machine && hr == E_ACCESSDENIED) ? "  (run elevated)" : "");
    return 1;
  }
  std::printf("ok    %s %ls under %s\n", add ? "registered" : "unregistered",
              kMediaSourceClsidString, machine ? "HKLM" : "HKCU");
  return 0;
}

int MachineRegistrationStatus() {
  wchar_t key_path[160] = {};
  ::swprintf_s(key_path, L"Software\\Classes\\CLSID\\%s\\InprocServer32",
               kMediaSourceClsidString);
  HKEY key = nullptr;
  const LSTATUS open_status = ::RegOpenKeyExW(HKEY_LOCAL_MACHINE, key_path, 0, KEY_READ, &key);
  if (open_status != ERROR_SUCCESS) {
    std::printf("not-installed  HKLM source registration missing (%ld)\n", open_status);
    return 1;
  }

  wchar_t registered_path[MAX_PATH] = {};
  DWORD type = 0;
  DWORD bytes = sizeof(registered_path);
  const LSTATUS read_status = ::RegQueryValueExW(
      key, nullptr, nullptr, &type, reinterpret_cast<BYTE*>(registered_path), &bytes);
  ::RegCloseKey(key);
  if (read_status != ERROR_SUCCESS || type != REG_SZ) {
    std::printf("not-installed  invalid HKLM source registration (%ld)\n", read_status);
    return 1;
  }

  const std::wstring expected = SourceDllPath();
  if (::_wcsicmp(registered_path, expected.c_str()) != 0) {
    std::printf("repair-required  registered=%ls expected=%ls\n", registered_path,
                expected.c_str());
    return 2;
  }
  std::printf("ok    machine registration points to %ls\n", registered_path);
  return 0;
}

// Pull `frames` samples straight from the media source, verifying each one has
// the expected size, a monotonically advancing timestamp, and pixels that differ
// from the previous frame. A static or frozen feed fails here rather than in a
// meeting.
int DriveMediaSource(int frames) {
  // The in-process harness verifies Media Foundation delivery with a moving,
  // decodable pattern. Production Frame Server activation never inherits this
  // process-scoped override and therefore reads only the shared stage region.
  ::SetEnvironmentVariableW(L"TWINSCRIPT_VCAM_SYNTHETIC", L"1");
  // Mirror what MFCreateVirtualCamera does: the registered CLSID is an
  // activation object, and the media source comes from ActivateObject(). Going
  // straight for IMFMediaSource would test a path Windows never takes.
  ComPtr<IMFActivate> activate;
  HRESULT hr = ::CoCreateInstance(kMediaSourceClsid, nullptr, CLSCTX_INPROC_SERVER,
                                  __uuidof(IMFActivate),
                                  reinterpret_cast<void**>(activate.GetAddressOf()));
  if (FAILED(hr)) return Fail("CoCreateInstance(IMFActivate)", hr);
  Ok("CoCreateInstance(IMFActivate)");

  ComPtr<IMFMediaSource> source;
  hr = activate->ActivateObject(__uuidof(IMFMediaSource),
                                reinterpret_cast<void**>(source.GetAddressOf()));
  if (FAILED(hr)) return Fail("ActivateObject(IMFMediaSource)", hr);
  Ok("ActivateObject(IMFMediaSource)");

  DWORD characteristics = 0;
  hr = source->GetCharacteristics(&characteristics);
  if (FAILED(hr)) return Fail("GetCharacteristics", hr);
  std::printf("ok    characteristics=0x%lX%s\n", characteristics,
              (characteristics & MFMEDIASOURCE_IS_LIVE) ? " (live)" : "");

  // In production the Frame Server owns the allocator and hands it over via
  // IMFSampleAllocatorControl; the source declares
  // MFSampleAllocatorUsage_UsesProvidedAllocator and never makes one itself.
  // This harness has to play that role too, otherwise it drives the source
  // along a path Windows never takes — which is exactly the mistake that let
  // `drive` pass for weeks while the real camera delivered nothing.
  ComPtr<IMFSampleAllocatorControl> allocator_control;
  hr = source->QueryInterface(__uuidof(IMFSampleAllocatorControl),
                              reinterpret_cast<void**>(allocator_control.GetAddressOf()));
  if (FAILED(hr)) return Fail("QueryInterface(IMFSampleAllocatorControl)", hr);

  DWORD input_stream = 0;
  MFSampleAllocatorUsage usage = MFSampleAllocatorUsage_UsesProvidedAllocator;
  hr = allocator_control->GetAllocatorUsage(0, &input_stream, &usage);
  if (FAILED(hr)) return Fail("GetAllocatorUsage", hr);
  std::printf("ok    allocator usage=%d (%s)\n", static_cast<int>(usage),
              usage == MFSampleAllocatorUsage_UsesProvidedAllocator ? "provided"
                                                                    : "own");

  if (usage == MFSampleAllocatorUsage_UsesProvidedAllocator) {
    ComPtr<IMFVideoSampleAllocator> allocator;
    hr = ::MFCreateVideoSampleAllocatorEx(
        __uuidof(IMFVideoSampleAllocator),
        reinterpret_cast<void**>(allocator.GetAddressOf()));
    if (FAILED(hr)) return Fail("MFCreateVideoSampleAllocatorEx", hr);
    hr = allocator_control->SetDefaultAllocator(0, allocator.Get());
    if (FAILED(hr)) return Fail("SetDefaultAllocator", hr);
    Ok("SetDefaultAllocator");
  }

  // MFCreateSourceReaderFromMediaSource exercises the same Start/RequestSample
  // path the frame server uses, without hand-rolling the event pump.
  ComPtr<IMFAttributes> reader_attributes;
  hr = ::MFCreateAttributes(reader_attributes.GetAddressOf(), 1);
  if (FAILED(hr)) return Fail("MFCreateAttributes", hr);
  hr = reader_attributes->SetUINT32(MF_SOURCE_READER_DISCONNECT_MEDIASOURCE_ON_SHUTDOWN, TRUE);
  if (FAILED(hr)) return Fail("SetUINT32(disconnect on shutdown)", hr);

  ComPtr<IMFSourceReader> reader;
  hr = ::MFCreateSourceReaderFromMediaSource(source.Get(), reader_attributes.Get(),
                                             reader.GetAddressOf());
  if (FAILED(hr)) return Fail("MFCreateSourceReaderFromMediaSource", hr);
  Ok("MFCreateSourceReaderFromMediaSource");

  // Enumerate every advertised type, so a mismatch between what the source
  // offers and what a consumer picks is visible rather than inferred.
  for (DWORD i = 0;; ++i) {
    ComPtr<IMFMediaType> candidate;
    if (FAILED(reader->GetNativeMediaType(0, i, candidate.GetAddressOf()))) break;
    GUID candidate_subtype = GUID_NULL;
    candidate->GetGUID(MF_MT_SUBTYPE, &candidate_subtype);
    UINT32 w = 0, h = 0;
    ::MFGetAttributeSize(candidate.Get(), MF_MT_FRAME_SIZE, &w, &h);
    std::printf("      offered[%lu]: %s %ux%u\n", i,
                candidate_subtype == MFVideoFormat_NV12    ? "NV12"
                : candidate_subtype == MFVideoFormat_RGB32 ? "RGB32"
                                                           : "other",
                w, h);
  }

  ComPtr<IMFMediaType> native_type;
  hr = reader->GetNativeMediaType(0, 0, native_type.GetAddressOf());
  if (FAILED(hr)) return Fail("GetNativeMediaType", hr);
  UINT32 width = 0, height = 0, rate_num = 0, rate_den = 0;
  ::MFGetAttributeSize(native_type.Get(), MF_MT_FRAME_SIZE, &width, &height);
  ::MFGetAttributeRatio(native_type.Get(), MF_MT_FRAME_RATE, &rate_num, &rate_den);
  GUID subtype = GUID_NULL;
  native_type->GetGUID(MF_MT_SUBTYPE, &subtype);
  const bool is_nv12 = subtype == MFVideoFormat_NV12;
  std::printf("ok    native type %ux%u @ %u/%u %s\n", width, height, rate_num, rate_den,
              is_nv12 ? "NV12" : "RGB32");

  const DWORD expected_bytes =
      is_nv12 ? width * height * 3 / 2 : width * height * 4;
  LONGLONG previous_time = -1;
  uint64_t previous_hash = 0;
  uint32_t previous_index = 0;
  bool have_previous = false;
  int delivered = 0;

  for (int i = 0; i < frames; ++i) {
    DWORD stream_index = 0, flags = 0;
    LONGLONG timestamp = 0;
    ComPtr<IMFSample> sample;
    hr = reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, &stream_index, &flags,
                            &timestamp, sample.GetAddressOf());
    if (FAILED(hr)) return Fail("ReadSample", hr);
    if (!sample) {
      std::printf("FAIL  ReadSample returned no sample (flags=0x%lX)\n", flags);
      return 1;
    }

    ComPtr<IMFMediaBuffer> buffer;
    hr = sample->ConvertToContiguousBuffer(buffer.GetAddressOf());
    if (FAILED(hr)) return Fail("ConvertToContiguousBuffer", hr);

    BYTE* data = nullptr;
    DWORD max_length = 0, current_length = 0;
    hr = buffer->Lock(&data, &max_length, &current_length);
    if (FAILED(hr)) return Fail("IMFMediaBuffer::Lock", hr);

    if (current_length != expected_bytes) {
      std::printf("FAIL  frame %d has %lu bytes, expected %lu\n", i, current_length,
                  expected_bytes);
      buffer->Unlock();
      return 1;
    }
    if (previous_time >= 0 && timestamp <= previous_time) {
      std::printf("FAIL  frame %d timestamp %lld did not advance past %lld\n", i, timestamp,
                  previous_time);
      buffer->Unlock();
      return 1;
    }
    const uint64_t hash = HashFrame(data, current_length);
    const uint32_t encoded_index = DecodeFrameIndex(data, width, is_nv12);
    if (have_previous) {
      if (hash == previous_hash) {
        std::printf("FAIL  frame %d is byte-identical to the previous frame (frozen feed)\n", i);
        buffer->Unlock();
        return 1;
      }
      if (encoded_index != previous_index + 1) {
        std::printf("FAIL  frame %d carries ordinal %u, expected %u (frames out of order)\n", i,
                    encoded_index, previous_index + 1);
        buffer->Unlock();
        return 1;
      }
    }
    previous_hash = hash;
    previous_index = encoded_index;
    have_previous = true;
    previous_time = timestamp;
    ++delivered;

    buffer->Unlock();
  }

  std::printf(
      "ok    %d frames, %lu bytes each, timestamps advancing, ordinals sequential to %u\n",
      delivered, expected_bytes, previous_index);
  reader.Reset();
  source->Shutdown();
  Ok("Shutdown");
  return 0;
}

// Create the virtual camera and hold it open. `seconds` <= 0 waits for Enter.
int HostVirtualCamera(int seconds) {
  ComPtr<IMFVirtualCamera> camera;
  HRESULT hr = ::MFCreateVirtualCamera(
      MFVirtualCameraType_SoftwareCameraSource, MFVirtualCameraLifetime_Session,
      MFVirtualCameraAccess_CurrentUser, kCameraFriendlyName, kMediaSourceClsidString,
      nullptr, 0, camera.GetAddressOf());
  if (FAILED(hr)) return Fail("MFCreateVirtualCamera", hr);
  Ok("MFCreateVirtualCamera");

  // Deliberately NOT calling IMFVirtualCamera::AddDeviceSourceInfo. It looked
  // like the missing link that tells the frame server what to instantiate, but
  // it is for associating a virtual camera with an *existing physical* device:
  // passing a synthetic
  // `@device:pnp:\\?\root#media#0000#{KSCATEGORY_VIDEO_CAMERA}\{our CLSID}`
  // moniker fails with 0x80070037 ERROR_DEV_NOT_EXIST and leaves the camera
  // unstarted, so it is strictly worse than omitting it.
  hr = camera->Start(nullptr);
  if (FAILED(hr)) {
    camera->Remove();
    return Fail("IMFVirtualCamera::Start", hr);
  }
  std::printf("ok    camera '%ls' started\n", kCameraFriendlyName);

  if (seconds > 0) {
    std::printf("      holding for %d seconds...\n", seconds);
    ::Sleep(static_cast<DWORD>(seconds) * 1000);
  } else {
    std::printf("      press Enter to stop...\n");
    (void)std::getchar();
  }

  hr = camera->Stop();
  if (FAILED(hr)) std::printf("warn  Stop 0x%08lX\n", static_cast<unsigned long>(hr));
  hr = camera->Remove();
  if (FAILED(hr)) std::printf("warn  Remove 0x%08lX\n", static_cast<unsigned long>(hr));
  camera->Shutdown();
  Ok("camera stopped and removed");
  return 0;
}

int ConsumeCamera(int frames);  // defined below; used by HostAndConsume

// Create the camera, start it, and read frames from it in ONE process.
//
// `camera` and `consume` are deliberately separate — one holds the lifetime, the
// other plays the meeting app — but that requires two coordinated processes, so
// there was no single command that answered "does the frame server actually
// stream this source?". This is that command, and it mirrors exactly the harness
// that proved Microsoft's reference camera streams on this machine, so the two
// results are directly comparable.
int HostAndConsume(int frames) {
  ComPtr<IMFVirtualCamera> camera;
  HRESULT hr = ::MFCreateVirtualCamera(
      MFVirtualCameraType_SoftwareCameraSource, MFVirtualCameraLifetime_Session,
      MFVirtualCameraAccess_CurrentUser, kCameraFriendlyName, kMediaSourceClsidString,
      nullptr, 0, camera.GetAddressOf());
  if (FAILED(hr)) return Fail("MFCreateVirtualCamera", hr);
  Ok("MFCreateVirtualCamera");

  hr = camera->Start(nullptr);
  if (FAILED(hr)) {
    camera->Remove();
    camera->Shutdown();
    return Fail("IMFVirtualCamera::Start", hr);
  }
  Ok("IMFVirtualCamera::Start");

  const int result = ConsumeCamera(frames > 0 ? frames : 10);

  camera->Stop();
  camera->Remove();
  camera->Shutdown();
  return result;
}

std::wstring Widen(const char* value) {
  if (!value || !*value) return {};
  const int count = ::MultiByteToWideChar(CP_UTF8, 0, value, -1, nullptr, 0);
  if (count <= 1) return {};
  std::wstring result(static_cast<size_t>(count), L'\0');
  ::MultiByteToWideChar(CP_UTF8, 0, value, -1, result.data(), count);
  result.resize(static_cast<size_t>(count - 1));
  return result;
}

const char* OptionValue(int argc, char** argv, const char* name) {
  for (int i = 2; i + 1 < argc; ++i) {
    if (std::strcmp(argv[i], name) == 0) return argv[i + 1];
  }
  return nullptr;
}

HANDLE ConnectHealthPipe(const std::wstring& pipe_name) {
  const ULONGLONG deadline = ::GetTickCount64() + 5000;
  while (::GetTickCount64() < deadline) {
    HANDLE pipe = ::CreateFileW(pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                                OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (pipe != INVALID_HANDLE_VALUE) return pipe;
    const DWORD error = ::GetLastError();
    if (error != ERROR_PIPE_BUSY && error != ERROR_FILE_NOT_FOUND) break;
    ::WaitNamedPipeW(pipe_name.c_str(), 250);
  }
  return INVALID_HANDLE_VALUE;
}

bool WriteHealth(HANDLE pipe, const char* state, HRESULT code = S_OK,
                 const char* message = nullptr) {
  char line[512] = {};
  const int length = message
                         ? ::_snprintf_s(line, sizeof(line), _TRUNCATE,
                                         "{\"state\":\"%s\",\"code\":%ld,\"message\":\"%s\"}\n",
                                         state, static_cast<long>(code), message)
                         : ::_snprintf_s(line, sizeof(line), _TRUNCATE,
                                         "{\"state\":\"%s\",\"code\":%ld}\n", state,
                                         static_cast<long>(code));
  if (length <= 0) return false;
  DWORD written = 0;
  return ::WriteFile(pipe, line, static_cast<DWORD>(length), &written, nullptr) &&
         written == static_cast<DWORD>(length);
}

enum class ControlResult { kContinue, kStop, kDisconnected };

ControlResult ReadControl(HANDLE pipe, std::string* pending) {
  DWORD available = 0;
  if (!::PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) {
    return ControlResult::kDisconnected;
  }
  if (available == 0) return ControlResult::kContinue;

  char buffer[256] = {};
  DWORD read = 0;
  if (!::ReadFile(pipe, buffer,
                  available < sizeof(buffer) ? available : static_cast<DWORD>(sizeof(buffer) - 1),
                  &read, nullptr)) {
    return ControlResult::kDisconnected;
  }
  pending->append(buffer, read);
  if (pending->find("\"command\":\"stop\"") != std::string::npos) {
    return ControlResult::kStop;
  }
  if (pending->size() > 4096) pending->erase(0, pending->size() - 1024);
  return ControlResult::kContinue;
}

// Production lifetime owner. Pixels never enter this pipe: the Frame Server
// media source maps the region named by TWINSCRIPT_VCAM_REGION_PATH directly.
// The pipe carries only health and the stop command so a companion failure is
// isolated from the live transcription session.
int ServeVirtualCamera(const std::wstring& pipe_name, const char* region_path) {
  if (pipe_name.empty() || !region_path || !*region_path) {
    std::printf("FAIL  serve requires --region and --pipe\n");
    return 2;
  }
  if (!::SetEnvironmentVariableA("TWINSCRIPT_VCAM_REGION_PATH", region_path)) {
    return Fail("SetEnvironmentVariable(TWINSCRIPT_VCAM_REGION_PATH)",
                HRESULT_FROM_WIN32(::GetLastError()));
  }

  HANDLE pipe = ConnectHealthPipe(pipe_name);
  if (pipe == INVALID_HANDLE_VALUE) {
    return Fail("connect health pipe", HRESULT_FROM_WIN32(::GetLastError()));
  }

  ComPtr<IMFVirtualCamera> camera;
  HRESULT hr = ::MFCreateVirtualCamera(
      MFVirtualCameraType_SoftwareCameraSource, MFVirtualCameraLifetime_Session,
      MFVirtualCameraAccess_CurrentUser, kCameraFriendlyName, kMediaSourceClsidString,
      nullptr, 0, camera.GetAddressOf());
  if (FAILED(hr)) {
    WriteHealth(pipe, "failed", hr, "MFCreateVirtualCamera failed");
    ::CloseHandle(pipe);
    return Fail("MFCreateVirtualCamera", hr);
  }
  if (!WriteHealth(pipe, "ready")) {
    camera->Shutdown();
    ::CloseHandle(pipe);
    return 3;
  }

  hr = camera->Start(nullptr);
  if (FAILED(hr)) {
    WriteHealth(pipe, "failed", hr, "IMFVirtualCamera::Start failed");
    camera->Remove();
    camera->Shutdown();
    ::CloseHandle(pipe);
    return Fail("IMFVirtualCamera::Start", hr);
  }
  if (!WriteHealth(pipe, "streaming")) {
    camera->Stop();
    camera->Remove();
    camera->Shutdown();
    ::CloseHandle(pipe);
    return 3;
  }

  std::string control;
  int result = 0;
  for (;;) {
    const ControlResult control_result = ReadControl(pipe, &control);
    if (control_result == ControlResult::kStop) break;
    if (control_result == ControlResult::kDisconnected) {
      result = 4;
      break;
    }
    ::Sleep(50);
  }

  WriteHealth(pipe, "stopping");
  hr = camera->Stop();
  if (FAILED(hr) && result == 0) result = 5;
  hr = camera->Remove();
  if (FAILED(hr) && result == 0) result = 6;
  camera->Shutdown();
  ::CloseHandle(pipe);
  return result;
}

// Open the registered camera the way a meeting app does — by enumerating capture
// devices and activating the one with our friendly name — then read frames.
// This is the only check that proves the frame server can host the source.
int ConsumeCamera(int frames) {
  ComPtr<IMFAttributes> attributes;
  HRESULT hr = ::MFCreateAttributes(attributes.GetAddressOf(), 1);
  if (FAILED(hr)) return Fail("MFCreateAttributes", hr);
  hr = attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                           MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
  if (FAILED(hr)) return Fail("SetGUID(vidcap)", hr);

  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  hr = ::MFEnumDeviceSources(attributes.Get(), &devices, &count);
  if (FAILED(hr)) return Fail("MFEnumDeviceSources", hr);

  ComPtr<IMFActivate> match;
  for (UINT32 i = 0; i < count; ++i) {
    WCHAR* name = nullptr;
    UINT32 length = 0;
    if (SUCCEEDED(devices[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
                                                 &name, &length))) {
      std::printf("      device: %ls\n", name);
      // Windows decorates the registered friendly name — it enumerates as
      // "<name> (Windows Virtual Camera)" — so match on the prefix we chose
      // rather than the full string the OS presents.
      if (::wcsncmp(name, kCameraFriendlyName, ::wcslen(kCameraFriendlyName)) == 0) {
        match = devices[i];
      }
      ::CoTaskMemFree(name);
    }
    devices[i]->Release();
  }
  ::CoTaskMemFree(devices);

  if (!match) {
    std::printf("FAIL  '%ls' was not enumerated\n", kCameraFriendlyName);
    return 1;
  }
  Ok("camera enumerated by friendly name");

  ComPtr<IMFMediaSource> source;
  hr = match->ActivateObject(__uuidof(IMFMediaSource),
                             reinterpret_cast<void**>(source.GetAddressOf()));
  if (FAILED(hr)) return Fail("ActivateObject(camera)", hr);
  Ok("ActivateObject(camera)");

  ComPtr<IMFSourceReader> reader;
  hr = ::MFCreateSourceReaderFromMediaSource(source.Get(), nullptr, reader.GetAddressOf());
  if (FAILED(hr)) return Fail("MFCreateSourceReaderFromMediaSource", hr);

  int delivered = 0;
  LONGLONG previous_time = -1;
  for (int i = 0; i < frames; ++i) {
    DWORD stream_index = 0, flags = 0;
    LONGLONG timestamp = 0;
    ComPtr<IMFSample> sample;
    hr = reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, &stream_index, &flags,
                            &timestamp, sample.GetAddressOf());
    if (FAILED(hr)) return Fail("ReadSample(camera)", hr);
    if (!sample) continue;
    ComPtr<IMFMediaBuffer> buffer;
    if (FAILED(sample->ConvertToContiguousBuffer(buffer.GetAddressOf()))) continue;
    DWORD length = 0;
    buffer->GetCurrentLength(&length);
    if (delivered == 0) std::printf("ok    first frame: %lu bytes at %lld\n", length, timestamp);
    if (previous_time >= 0 && timestamp <= previous_time) {
      std::printf("FAIL  camera timestamp did not advance (%lld after %lld)\n", timestamp,
                  previous_time);
      reader.Reset();
      source->Shutdown();
      return 1;
    }
    previous_time = timestamp;
    ++delivered;
  }

  std::printf("%s  %d frames read from the camera (last timestamp %lld)\n",
              delivered > 0 ? "ok  " : "FAIL", delivered, previous_time);
  reader.Reset();
  source->Shutdown();
  return delivered > 0 ? 0 : 1;
}

}  // namespace

int main(int argc, char** argv) {
  const std::string command = argc > 1 ? argv[1] : "drive";
  const int amount = argc > 2 ? std::atoi(argv[2]) : 0;

  if (command == "register") return RunDllRegistration(true, false);
  if (command == "unregister") return RunDllRegistration(false, false);
  if (command == "register-machine") return RunDllRegistration(true, true);
  if (command == "unregister-machine") return RunDllRegistration(false, true);
  if (command == "status-machine") return MachineRegistrationStatus();

  HRESULT hr = ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(hr)) return Fail("CoInitializeEx", hr);
  hr = ::MFStartup(MF_VERSION, MFSTARTUP_FULL);
  if (FAILED(hr)) {
    ::CoUninitialize();
    return Fail("MFStartup", hr);
  }

  int result = 1;
  if (command == "drive") {
    result = DriveMediaSource(amount > 0 ? amount : 10);
  } else if (command == "camera") {
    result = HostVirtualCamera(amount);
  } else if (command == "consume") {
    result = ConsumeCamera(amount > 0 ? amount : 10);
  } else if (command == "selftest") {
    result = HostAndConsume(amount);
  } else if (command == "serve") {
    result = ServeVirtualCamera(Widen(OptionValue(argc, argv, "--pipe")),
                                OptionValue(argc, argv, "--region"));
  } else {
    std::printf(
        "usage: vcam-host <register|unregister|register-machine|unregister-machine|"
        "status-machine|drive|camera|consume|selftest> [count|seconds]\n"
        "       vcam-host serve --region <file> --pipe <name>\n");
  }

  ::MFShutdown();
  ::CoUninitialize();
  return result;
}
