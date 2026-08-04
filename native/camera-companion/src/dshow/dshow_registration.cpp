// Registration for the DirectShow virtual camera.
//
// A DirectShow capture source is discovered through two separate things, and
// missing either one makes the camera invisible:
//
//   1. An ordinary COM in-proc server registration under
//      HKCR\CLSID\<clsid>\InprocServer32.
//   2. An entry in the video-input-device category, written through
//      IFilterMapper2::RegisterFilter. This is what puts the name in a client's
//      camera list.
//
// Verified against the working OBS registration on the target machine: it appears
// under CLSID_VideoInputDeviceCategory ({860BB310-5D01-11d0-BD3B-00A0C911CE86})
// with ThreadingModel=Both.

#include "dshow_registration.h"

#include <windows.h>
#include <dshow.h>
#include <strmif.h>
#include <initguid.h>
#include <string>

#include "dshow_guids.h"
#include "dshow_log.h"

namespace twinscript::dshow {
namespace {

std::wstring ModulePath(HMODULE module) {
  wchar_t path[MAX_PATH] = {};
  const DWORD written = ::GetModuleFileNameW(module, path, MAX_PATH);
  return (written == 0 || written == MAX_PATH) ? std::wstring() : std::wstring(path);
}

HRESULT SetRegistryString(HKEY root, const wchar_t* subkey, const wchar_t* name,
                          const wchar_t* value) {
  HKEY key = nullptr;
  LSTATUS status = ::RegCreateKeyExW(root, subkey, 0, nullptr, 0, KEY_WRITE, nullptr,
                                     &key, nullptr);
  if (status != ERROR_SUCCESS) return HRESULT_FROM_WIN32(status);
  const DWORD bytes = static_cast<DWORD>((::wcslen(value) + 1) * sizeof(wchar_t));
  status = ::RegSetValueExW(key, name, 0, REG_SZ,
                            reinterpret_cast<const BYTE*>(value), bytes);
  ::RegCloseKey(key);
  return HRESULT_FROM_WIN32(status);
}

// Recursive delete: RegDeleteKeyW only removes a key with no subkeys, and the
// CLSID key always has InprocServer32 beneath it.
void DeleteKeyTree(HKEY root, const std::wstring& subkey) {
  HKEY key = nullptr;
  if (::RegOpenKeyExW(root, subkey.c_str(), 0, KEY_READ | KEY_WRITE, &key) !=
      ERROR_SUCCESS) {
    return;
  }
  for (;;) {
    wchar_t child[256] = {};
    DWORD length = ARRAYSIZE(child);
    if (::RegEnumKeyExW(key, 0, child, &length, nullptr, nullptr, nullptr, nullptr) !=
        ERROR_SUCCESS) {
      break;
    }
    DeleteKeyTree(root, subkey + L"\\" + child);
  }
  ::RegCloseKey(key);
  ::RegDeleteKeyW(root, subkey.c_str());
}

// The category entry. Written through IFilterMapper2 rather than by hand: the
// mapper owns the layout of the Instance subkey and its binary FilterData blob,
// and hand-writing that is how virtual cameras end up half-registered.
HRESULT RegisterCategoryEntry(bool add) {
  IFilterMapper2* mapper = nullptr;
  HRESULT hr = ::CoCreateInstance(CLSID_FilterMapper2, nullptr, CLSCTX_INPROC_SERVER,
                                  IID_IFilterMapper2, reinterpret_cast<void**>(&mapper));
  if (FAILED(hr)) {
    LogLine("CoCreateInstance(FilterMapper2) failed hr=0x%08lX",
            static_cast<unsigned long>(hr));
    return hr;
  }

  if (!add) {
    hr = mapper->UnregisterFilter(&CLSID_VideoInputDeviceCategory, kFilterName,
                                  kFilterClsid);
    // Absent is success for an uninstall: repeated removal must not fail.
    if (hr == VFW_E_NOT_FOUND || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) {
      hr = S_OK;
    }
    LogLine("UnregisterFilter hr=0x%08lX", static_cast<unsigned long>(hr));
    mapper->Release();
    return hr;
  }

  REGFILTERPINS pin = {};
  pin.strName = const_cast<wchar_t*>(L"Output");
  pin.bRendered = FALSE;
  pin.bOutput = TRUE;
  pin.bZero = FALSE;
  pin.bMany = FALSE;
  pin.clsConnectsToFilter = &CLSID_NULL;
  pin.strConnectsToPin = nullptr;
  pin.nMediaTypes = 0;
  pin.lpMediaType = nullptr;

  REGFILTER2 filter = {};
  filter.dwVersion = 1;
  // MERIT_DO_NOT_USE keeps the graph builder from silently choosing this camera
  // for unrelated capture graphs, while leaving it explicitly selectable. This is
  // the merit a virtual camera should carry.
  filter.dwMerit = MERIT_DO_NOT_USE;
  filter.cPins = 1;
  filter.rgPins = &pin;

  hr = mapper->RegisterFilter(kFilterClsid, kFilterName, nullptr,
                              &CLSID_VideoInputDeviceCategory, kFilterName, &filter);
  LogLine("RegisterFilter '%ls' hr=0x%08lX%s", kFilterName,
          static_cast<unsigned long>(hr),
          hr == E_ACCESSDENIED
              // IFilterMapper2 writes the category under HKEY_CLASSES_ROOT, which
              // resolves to HKLM regardless of which hive the COM server went to.
              // So a DirectShow capture filter always needs elevation to install -
              // the same reason OBS ships an elevated installer.
              ? "  (category registration always needs HKLM; run elevated)"
              : "");
  mapper->Release();
  return hr;
}

}  // namespace

HRESULT RegisterFilterServer(HMODULE module, HKEY root, bool add) {
  const std::wstring clsid_key =
      std::wstring(L"Software\\Classes\\CLSID\\") + kFilterClsidString;
  const std::wstring inproc_key = clsid_key + L"\\InprocServer32";

  if (!add) {
    // Category entry first: leaving it behind while the COM server is gone
    // produces a camera that enumerates and then fails to activate.
    const HRESULT category = RegisterCategoryEntry(false);
    DeleteKeyTree(root, clsid_key);
    LogLine("unregistered %ls", kFilterClsidString);
    return category;
  }

  const std::wstring path = ModulePath(module);
  if (path.empty()) return E_UNEXPECTED;

  HRESULT hr = SetRegistryString(root, clsid_key.c_str(), nullptr, kFilterName);
  if (FAILED(hr)) return hr;
  hr = SetRegistryString(root, inproc_key.c_str(), nullptr, path.c_str());
  if (FAILED(hr)) return hr;
  // Both: the filter is loaded into consumers with either apartment model, and a
  // mismatch here shows up as an activation failure inside the client.
  hr = SetRegistryString(root, inproc_key.c_str(), L"ThreadingModel", L"Both");
  if (FAILED(hr)) return hr;

  LogLine("registered %ls -> %ls", kFilterClsidString, path.c_str());

  hr = RegisterCategoryEntry(true);
  if (FAILED(hr)) {
    // Roll the COM server back. A filter registered as a COM class but absent
    // from the device category is the worst of both worlds: some consumers list it
    // from a stale cache and then fail to activate it, which reads as a broken
    // camera rather than a failed install. Either both halves land or neither.
    DeleteKeyTree(root, clsid_key);
    LogLine("rolled back %ls: category registration failed", kFilterClsidString);
  }
  return hr;
}

}  // namespace twinscript::dshow
