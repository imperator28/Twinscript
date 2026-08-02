// W4 kill-risk probe.
//
// Answers, on the machine it runs on, the questions that decide whether the
// native virtual-camera architecture in docs/windows/virtual-camera.md is
// viable at all:
//
//   1. Is the OS new enough? MFCreateVirtualCamera has a minimum supported
//      client of Windows build 22000.
//   2. Does MFCreateVirtualCamera link and execute from this SDK, or is the
//      symbol absent / stubbed?
//   3. Can native code enumerate video capture devices — i.e. would our own
//      camera show up the same way OBS Virtual Camera does?
//   4. What does Windows return for a source CLSID that is not registered?
//      REGDB_E_CLASSNOTREG means the call reached source resolution, which is
//      the outcome that says "the plumbing works, now go write the source".
//
// Prints a machine-readable summary so the result can be pasted into the
// validation matrix without hand-transcribing HRESULTs.

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfvirtualcamera.h>
#include <mfobjects.h>
#include <initguid.h>
#include <ks.h>
#include <ksmedia.h>

#include <cstdio>
#include <string>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "mfsensorgroup.lib")
#pragma comment(lib, "ole32.lib")

namespace {

void PrintResult(const char* key, const char* value) {
  std::printf("%-28s %s\n", key, value);
}

void PrintHr(const char* key, HRESULT hr, const char* note) {
  std::printf("%-28s 0x%08lX  %s\n", key, static_cast<unsigned long>(hr), note);
}

// RtlGetVersion reports the true build number; GetVersionEx is subject to
// application-compatibility shimming and would under-report on Windows 11.
bool RealOsBuild(DWORD* major, DWORD* minor, DWORD* build) {
  using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  HMODULE ntdll = ::GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) return false;
  auto rtl_get_version =
      reinterpret_cast<RtlGetVersionFn>(::GetProcAddress(ntdll, "RtlGetVersion"));
  if (!rtl_get_version) return false;
  RTL_OSVERSIONINFOW info{};
  info.dwOSVersionInfoSize = sizeof(info);
  if (rtl_get_version(&info) != 0) return false;
  *major = info.dwMajorVersion;
  *minor = info.dwMinorVersion;
  *build = info.dwBuildNumber;
  return true;
}

// Enumerate video capture devices the same way a meeting app would, so the
// probe proves our future camera would be discoverable by the same mechanism
// that currently surfaces OBS Virtual Camera.
HRESULT ListCaptureDevices(int* device_count) {
  *device_count = 0;
  IMFAttributes* attributes = nullptr;
  HRESULT hr = ::MFCreateAttributes(&attributes, 1);
  if (FAILED(hr)) return hr;

  hr = attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                           MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
  if (FAILED(hr)) {
    attributes->Release();
    return hr;
  }

  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  hr = ::MFEnumDeviceSources(attributes, &devices, &count);
  attributes->Release();
  if (FAILED(hr)) return hr;

  std::printf("\nVideo capture devices (%u):\n", count);
  for (UINT32 i = 0; i < count; ++i) {
    WCHAR* name = nullptr;
    UINT32 name_length = 0;
    if (SUCCEEDED(devices[i]->GetAllocatedString(
            MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &name_length))) {
      std::printf("  [%u] %ls\n", i, name);
      ::CoTaskMemFree(name);
    } else {
      std::printf("  [%u] <no friendly name>\n", i);
    }
    devices[i]->Release();
  }
  ::CoTaskMemFree(devices);
  *device_count = static_cast<int>(count);
  return S_OK;
}

const char* DescribeCreateHr(HRESULT hr) {
  switch (hr) {
    case S_OK:
      return "created (unexpected for an unregistered CLSID)";
    case REGDB_E_CLASSNOTREG:
      return "REGDB_E_CLASSNOTREG - API reached source resolution: PLUMBING OK";
    case E_ACCESSDENIED:
      return "E_ACCESSDENIED - needs elevation or a different access scope";
    case E_INVALIDARG:
      return "E_INVALIDARG - argument shape rejected before resolution";
    case E_NOTIMPL:
      return "E_NOTIMPL - virtual camera not supported on this SKU";
    default:
      return "unexpected - investigate before building the media source";
  }
}

}  // namespace

int main() {
  std::printf("=== W4 native virtual-camera probe ===\n\n");

  DWORD major = 0, minor = 0, build = 0;
  if (RealOsBuild(&major, &minor, &build)) {
    char version[64];
    std::snprintf(version, sizeof(version), "%lu.%lu build %lu", major, minor, build);
    PrintResult("os.version", version);
    PrintResult("os.supports_mfvcam",
                build >= 22000 ? "YES (build >= 22000)" : "NO (build < 22000)");
  } else {
    PrintResult("os.version", "unavailable");
  }

  HRESULT hr = ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(hr)) {
    PrintHr("com.initialize", hr, "CoInitializeEx failed");
    return 1;
  }

  hr = ::MFStartup(MF_VERSION, MFSTARTUP_FULL);
  if (FAILED(hr)) {
    PrintHr("mf.startup", hr, "MFStartup failed");
    ::CoUninitialize();
    return 1;
  }
  PrintHr("mf.startup", hr, "OK");

  int device_count = 0;
  HRESULT enum_hr = ListCaptureDevices(&device_count);
  std::printf("\n");
  PrintHr("mf.enum_devices", enum_hr, SUCCEEDED(enum_hr) ? "OK" : "failed");

  // A CLSID generated for this probe alone. It is deliberately NOT registered:
  // the interesting result is how far Windows gets before it fails.
  const wchar_t* kUnregisteredSourceId =
      L"{1A6B7C2E-5D34-4F8A-9E1B-2C3D4E5F6A7B}";
  IMFVirtualCamera* camera = nullptr;
  HRESULT create_hr = ::MFCreateVirtualCamera(
      MFVirtualCameraType_SoftwareCameraSource,
      MFVirtualCameraLifetime_Session,
      MFVirtualCameraAccess_CurrentUser,
      L"Twinscript Probe",
      kUnregisteredSourceId,
      nullptr,
      0,
      &camera);
  PrintHr("mfvcam.create_unregistered", create_hr, DescribeCreateHr(create_hr));
  if (SUCCEEDED(create_hr) && camera) {
    camera->Remove();
    camera->Shutdown();
    camera->Release();
  }

  std::printf("\nverdict.api_callable       %s\n",
              create_hr == REGDB_E_CLASSNOTREG || SUCCEEDED(create_hr)
                  ? "YES"
                  : "INVESTIGATE");

  ::MFShutdown();
  ::CoUninitialize();
  return 0;
}
