// COM in-proc server for the virtual camera media source.
//
// Windows instantiates this by CLSID when a consumer opens the camera, so the
// DLL must be a well-behaved COM server: a class factory, a live-object count
// that keeps it loaded, and self-registration under HKCU (no admin needed, which
// matches MFVirtualCameraAccess_CurrentUser).

#include <windows.h>
#include <mfapi.h>

#include <cstdarg>
#include <cstdio>
#include <new>

#include "com_support.h"
#include "media_source.h"
#include "media_source_activate.h"
#include "module_lifetime.h"
#include "vcam_guids.h"
#include "vcam_log.h"

namespace bilingual::vcam {
namespace {

LONG g_lock_count = 0;
LONG g_object_count = 0;
HMODULE g_module = nullptr;

}  // namespace

void ModuleObjectCreated() { ::InterlockedIncrement(&g_object_count); }

void ModuleObjectDestroyed() { ::InterlockedDecrement(&g_object_count); }

// The frame server hosts this DLL in a service process with no console and no
// debugger attached, so the only way to learn whether Windows ever reached our
// code is a log file. Records the host process so it is obvious whether the
// caller was our own host, the frame server, or the consuming app.
void LogLine(const char* format, ...) {
  // Log under the installer-created ProgramData diagnostics directory. The
  // frame server runs as NT AUTHORITY\LocalService with its own TEMP under
  // C:\Windows\ServiceProfiles\, which the developer's account cannot read — so
  // a %TEMP% log silently hides every frame-server-side activation and makes it
  // look like Windows never loaded the source at all. The installer grants the
  // diagnostics directory narrowly scoped write access for that service.
  wchar_t program_data[MAX_PATH] = {};
  if (::GetEnvironmentVariableW(L"ProgramData", program_data, MAX_PATH) == 0) return;
  wchar_t path[MAX_PATH] = {};
  if (::_snwprintf_s(path, MAX_PATH, _TRUNCATE,
                     L"%s\\Bilingual Meeting Captions\\logs\\vcam-source.log",
                     program_data) <= 0) {
    return;
  }

  HANDLE file = ::CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return;

  wchar_t host[MAX_PATH] = {};
  ::GetModuleFileNameW(nullptr, host, MAX_PATH);

  char message[1024] = {};
  va_list args;
  va_start(args, format);
  ::vsnprintf_s(message, sizeof(message), _TRUNCATE, format, args);
  va_end(args);

  SYSTEMTIME now{};
  ::GetLocalTime(&now);
  char line[2048] = {};
  const int written = ::_snprintf_s(
      line, sizeof(line), _TRUNCATE, "%02u:%02u:%02u.%03u pid=%lu host=%ls | %s\r\n",
      now.wHour, now.wMinute, now.wSecond, now.wMilliseconds, ::GetCurrentProcessId(), host,
      message);
  if (written > 0) {
    DWORD ignored = 0;
    ::WriteFile(file, line, static_cast<DWORD>(written), &ignored, nullptr);
  }
  ::CloseHandle(file);
}

namespace {

class ClassFactory : public IClassFactory {
 public:
  ClassFactory() { ModuleObjectCreated(); }
  ~ClassFactory() { ModuleObjectDestroyed(); }

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IClassFactory)) {
      *out = static_cast<IClassFactory*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override { return ::InterlockedIncrement(&ref_count_); }

  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = ::InterlockedDecrement(&ref_count_);
    if (remaining == 0) delete this;
    return remaining;
  }

  HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown* outer, REFIID iid,
                                          void** out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    // Aggregation is not supported; a camera source is never an inner object.
    if (outer) return CLASS_E_NOAGGREGATION;

    // The registered CLSID is an *activation object*, not the media source:
    // MFCreateVirtualCamera asks for IMFActivate and calls ActivateObject()
    // later to get the source. Handing back a MediaSource here makes
    // IMFVirtualCamera::Start fail with a bare E_NOINTERFACE.
    MediaSourceActivate* activate = nullptr;
    HRESULT hr = MediaSourceActivate::CreateInstance(&activate);
    if (FAILED(hr)) {
      LogLine("ClassFactory::CreateInstance -> MediaSourceActivate 0x%08lX", hr);
      return hr;
    }
    hr = activate->QueryInterface(iid, out);
    LogLine("ClassFactory::CreateInstance iid={%08lX-%04X-%04X-...} 0x%08lX", iid.Data1,
            iid.Data2, iid.Data3, hr);
    activate->Release();
    return hr;
  }

  HRESULT STDMETHODCALLTYPE LockServer(BOOL lock) override {
    if (lock) {
      ::InterlockedIncrement(&g_lock_count);
    } else {
      ::InterlockedDecrement(&g_lock_count);
    }
    return S_OK;
  }

 private:
  LONG ref_count_ = 1;
};

// Write one string value, creating the key.
//
// Which root matters, and it is not a style choice. HKCU registration is enough
// for in-process activation, but the Windows Frame Server runs as
// NT AUTHORITY\LocalService and cannot see a user's HKCU hive — so a camera
// registered only per-user fails IMFVirtualCamera::Start with
// ERROR_PATH_NOT_FOUND. Machine-wide registration under HKLM is required for the
// frame server, and requires administrator.
HRESULT SetRegistryString(HKEY root, const wchar_t* subkey, const wchar_t* name,
                          const wchar_t* value) {
  HKEY key = nullptr;
  LSTATUS status = ::RegCreateKeyExW(root, subkey, 0, nullptr, REG_OPTION_NON_VOLATILE,
                                     KEY_WRITE, nullptr, &key, nullptr);
  if (status != ERROR_SUCCESS) return HRESULT_FROM_WIN32(status);
  const DWORD bytes = static_cast<DWORD>((::wcslen(value) + 1) * sizeof(wchar_t));
  status = ::RegSetValueExW(key, name, 0, REG_SZ,
                            reinterpret_cast<const BYTE*>(value), bytes);
  ::RegCloseKey(key);
  return status == ERROR_SUCCESS ? S_OK : HRESULT_FROM_WIN32(status);
}

}  // namespace
}  // namespace bilingual::vcam

using namespace bilingual::vcam;

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_module = module;
    ::DisableThreadLibraryCalls(module);
  }
  return TRUE;
}

extern "C" HRESULT __stdcall DllGetClassObject(REFCLSID clsid, REFIID iid, void** out) {
  if (!out) return E_POINTER;
  *out = nullptr;
  LogLine("DllGetClassObject clsid={%08lX-%04X-%04X-...} match=%d", clsid.Data1, clsid.Data2,
          clsid.Data3, clsid == kMediaSourceClsid ? 1 : 0);
  if (clsid != kMediaSourceClsid) return CLASS_E_CLASSNOTAVAILABLE;

  ClassFactory* factory = new (std::nothrow) ClassFactory();
  if (!factory) return E_OUTOFMEMORY;
  const HRESULT hr = factory->QueryInterface(iid, out);
  factory->Release();
  return hr;
}

extern "C" HRESULT __stdcall DllCanUnloadNow() {
  return g_object_count == 0 && g_lock_count == 0 ? S_OK : S_FALSE;
}

namespace bilingual::vcam {
namespace {

HRESULT RegisterUnder(HKEY root, const char* root_name) {
  wchar_t module_path[MAX_PATH] = {};
  if (::GetModuleFileNameW(g_module, module_path, MAX_PATH) == 0) {
    return HRESULT_FROM_WIN32(::GetLastError());
  }

  wchar_t clsid_key[128] = {};
  ::swprintf_s(clsid_key, L"Software\\Classes\\CLSID\\%s", kMediaSourceClsidString);
  HRESULT hr = SetRegistryString(root, clsid_key, nullptr, kComRegistryDescription);
  if (FAILED(hr)) {
    LogLine("RegisterUnder(%s) description 0x%08lX", root_name, hr);
    return hr;
  }

  wchar_t inproc_key[160] = {};
  ::swprintf_s(inproc_key, L"%s\\InprocServer32", clsid_key);
  hr = SetRegistryString(root, inproc_key, nullptr, module_path);
  if (FAILED(hr)) {
    LogLine("RegisterUnder(%s) module path 0x%08lX", root_name, hr);
    return hr;
  }
  // "Both" lets the frame server activate the source on whichever apartment it
  // uses without COM injecting a marshalling proxy.
  hr = SetRegistryString(root, inproc_key, L"ThreadingModel", L"Both");
  LogLine("RegisterUnder(%s) -> %ls 0x%08lX", root_name, module_path, hr);
  return hr;
}

HRESULT UnregisterUnder(HKEY root, const char* root_name) {
  wchar_t clsid_key[128] = {};
  ::swprintf_s(clsid_key, L"Software\\Classes\\CLSID\\%s", kMediaSourceClsidString);
  const LSTATUS status = ::RegDeleteTreeW(root, clsid_key);
  LogLine("UnregisterUnder(%s) status=%ld", root_name, status);
  if (status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND) return S_OK;
  return HRESULT_FROM_WIN32(status);
}

}  // namespace
}  // namespace bilingual::vcam

// Conventional COM self-registration writes machine-wide, and that is what the
// frame server needs. Requires administrator.
extern "C" HRESULT __stdcall DllRegisterServer() {
  return RegisterUnder(HKEY_LOCAL_MACHINE, "HKLM");
}

extern "C" HRESULT __stdcall DllUnregisterServer() {
  return UnregisterUnder(HKEY_LOCAL_MACHINE, "HKLM");
}

// Per-user registration, no elevation. Sufficient for in-process activation
// (the `drive` verification stage) but NOT for the frame server, so a camera
// registered this way cannot be started. `regsvr32 /i:user` maps here.
extern "C" HRESULT __stdcall DllInstall(BOOL install, LPCWSTR command_line) {
  const bool per_user = command_line && ::_wcsicmp(command_line, L"user") == 0;
  HKEY root = per_user ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE;
  const char* name = per_user ? "HKCU" : "HKLM";
  return install ? RegisterUnder(root, name) : UnregisterUnder(root, name);
}
