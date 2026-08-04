// DLL entry points for the DirectShow virtual camera.
//
// Exports the four things an in-proc COM server needs, plus DllInstall so the
// installer can choose HKLM or HKCU without a second binary.

#include <windows.h>
#include <shlwapi.h>
#include <objbase.h>
#include <cstdarg>
#include <cstdio>
#include <new>

#include "dshow_filter.h"
#include "dshow_guids.h"
#include "dshow_log.h"
#include "dshow_object.h"
#include "dshow_registration.h"

namespace twinscript::dshow {
namespace {

HMODULE g_module = nullptr;
LONG g_object_count = 0;
LONG g_lock_count = 0;

// Written beside the Media Foundation source's log but under a distinct name.
// Falls back to the module's own directory when ProgramData is not writable,
// which is the case for a consumer running as a restricted service account.
void ResolveLogPath(char* out, size_t size) {
  wchar_t program_data[MAX_PATH] = {};
  if (::GetEnvironmentVariableW(L"ProgramData", program_data, MAX_PATH)) {
    wchar_t directory[MAX_PATH] = {};
    ::swprintf_s(directory, L"%s\\Twinscript\\logs", program_data);
    ::CreateDirectoryW(directory, nullptr);
    wchar_t path[MAX_PATH] = {};
    ::swprintf_s(path, L"%s\\dshow-camera.log", directory);
    ::WideCharToMultiByte(CP_UTF8, 0, path, -1, out, static_cast<int>(size), nullptr,
                          nullptr);
    return;
  }
  out[0] = '\0';
}

}  // namespace

void ModuleObjectCreated() { ::InterlockedIncrement(&g_object_count); }
void ModuleObjectDestroyed() { ::InterlockedDecrement(&g_object_count); }

void LogLine(const char* format, ...) {
  static char path[MAX_PATH * 2] = {};
  static bool resolved = false;
  if (!resolved) {
    resolved = true;
    ResolveLogPath(path, sizeof(path));
  }
  if (!path[0]) return;

  char message[1024] = {};
  va_list args;
  va_start(args, format);
  ::vsnprintf(message, sizeof(message), format, args);
  va_end(args);

  // Every line carries the hosting process. On the Media Foundation path, not
  // knowing which process had loaded the DLL was the single most costly gap.
  wchar_t image[MAX_PATH] = {};
  ::GetModuleFileNameW(nullptr, image, MAX_PATH);
  char image_utf8[MAX_PATH * 2] = {};
  ::WideCharToMultiByte(CP_UTF8, 0, image, -1, image_utf8, sizeof(image_utf8), nullptr,
                        nullptr);

  SYSTEMTIME now = {};
  ::GetLocalTime(&now);

  char line[2048] = {};
  const int length =
      ::snprintf(line, sizeof(line), "%02u:%02u:%02u.%03u pid=%lu host=%s | %s\r\n",
                 now.wHour, now.wMinute, now.wSecond, now.wMilliseconds,
                 ::GetCurrentProcessId(), image_utf8, message);
  if (length <= 0) return;

  // Opened per line and shared for write: several consumer processes can hold the
  // camera at once, and losing the log to a sharing violation would defeat it.
  HANDLE file = ::CreateFileA(path, FILE_APPEND_DATA,
                              FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  ::WriteFile(file, line, static_cast<DWORD>(length), &written, nullptr);
  ::CloseHandle(file);
}

namespace {

class ClassFactory : public IClassFactory, public RefCounted<ClassFactory> {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
    if (!out) return E_POINTER;
    if (iid == IID_IUnknown || iid == IID_IClassFactory) {
      *out = static_cast<IClassFactory*>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  TWINSCRIPT_DSHOW_REFCOUNT(ClassFactory)

  HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown* outer, REFIID iid,
                                          void** out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    // Aggregation is not supported, and saying so is required rather than
    // optional: a consumer that aggregates and gets a non-aggregated object back
    // will corrupt its own reference counting.
    if (outer) return CLASS_E_NOAGGREGATION;
    LogGuid("ClassFactory::CreateInstance iid", iid, S_OK);
    return Filter::CreateInstance(iid, out);
  }

  HRESULT STDMETHODCALLTYPE LockServer(BOOL lock) override {
    if (lock) {
      ::InterlockedIncrement(&g_lock_count);
    } else {
      ::InterlockedDecrement(&g_lock_count);
    }
    return S_OK;
  }
};

}  // namespace
}  // namespace twinscript::dshow

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    twinscript::dshow::g_module = module;
    ::DisableThreadLibraryCalls(module);
  }
  return TRUE;
}

extern "C" HRESULT __stdcall DllGetClassObject(REFCLSID clsid, REFIID iid, void** out) {
  using namespace twinscript::dshow;
  if (!out) return E_POINTER;
  *out = nullptr;
  const bool match = clsid == kFilterClsid;
  LogLine("DllGetClassObject match=%d", match ? 1 : 0);
  if (!match) return CLASS_E_CLASSNOTAVAILABLE;

  auto* factory = new (std::nothrow) ClassFactory();
  if (!factory) return E_OUTOFMEMORY;
  const HRESULT hr = factory->QueryInterface(iid, out);
  factory->Release();
  return hr;
}

extern "C" HRESULT __stdcall DllCanUnloadNow() {
  using namespace twinscript::dshow;
  return (g_object_count == 0 && g_lock_count == 0) ? S_OK : S_FALSE;
}

extern "C" HRESULT __stdcall DllRegisterServer() {
  using namespace twinscript::dshow;
  return RegisterFilterServer(g_module, HKEY_LOCAL_MACHINE, true);
}

extern "C" HRESULT __stdcall DllUnregisterServer() {
  using namespace twinscript::dshow;
  return RegisterFilterServer(g_module, HKEY_LOCAL_MACHINE, false);
}

// `install` selects register or unregister; the command line selects the hive.
// "user" is a developer convenience only - a consumer running under another
// account cannot see an HKCU registration.
extern "C" HRESULT __stdcall DllInstall(BOOL install, LPCWSTR command_line) {
  using namespace twinscript::dshow;
  const bool user = command_line && ::_wcsicmp(command_line, L"user") == 0;
  return RegisterFilterServer(g_module, user ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE,
                              install != FALSE);
}
