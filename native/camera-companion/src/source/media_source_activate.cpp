#include "media_source_activate.h"

#include <new>

#include "vcam_log.h"

namespace twinscript::vcam {

HRESULT MediaSourceActivate::CreateInstance(MediaSourceActivate** out) {
  if (!out) return E_POINTER;
  *out = nullptr;

  MediaSourceActivate* activate = new (std::nothrow) MediaSourceActivate();
  if (!activate) return E_OUTOFMEMORY;

  // Windows writes virtual-camera configuration onto this object, so the
  // attribute store has to be real rather than a stub.
  const HRESULT hr = ::MFCreateAttributes(activate->attributes_.GetAddressOf(), 8);
  if (FAILED(hr)) {
    activate->Release();
    return hr;
  }
  *out = activate;
  return S_OK;
}

HRESULT MediaSourceActivate::QueryInterface(REFIID iid, void** out) {
  if (!out) return E_POINTER;
  *out = nullptr;
  if (iid == __uuidof(IUnknown)) {
    *out = static_cast<IMFActivate*>(this);
  } else if (iid == __uuidof(IMFActivate)) {
    *out = static_cast<IMFActivate*>(this);
  } else if (iid == __uuidof(IMFAttributes)) {
    *out = static_cast<IMFAttributes*>(this);
  } else {
    LogUnsupportedInterface("MediaSourceActivate", iid);
    return E_NOINTERFACE;
  }
  AddRef();
  return S_OK;
}

HRESULT MediaSourceActivate::ActivateObject(REFIID iid, void** out) {
  if (!out) return E_POINTER;
  *out = nullptr;
  Lock guard(&lock_);

  // Repeated activation returns the same source: Windows may activate more than
  // once, and a second media source would mean two independent frame timelines
  // for one camera.
  if (!source_) {
    MediaSource* raw = nullptr;
    const HRESULT hr = MediaSource::CreateInstance(attributes_.Get(), &raw);
    if (FAILED(hr)) {
      LogLine("MediaSourceActivate::ActivateObject create failed 0x%08lX", hr);
      return hr;
    }
    source_.Attach(raw);
  }

  const HRESULT hr = source_->QueryInterface(iid, out);
  LogLine("MediaSourceActivate::ActivateObject iid={%08lX-%04X-%04X-...} 0x%08lX", iid.Data1,
          iid.Data2, iid.Data3, hr);
  return hr;
}

HRESULT MediaSourceActivate::ShutdownObject() {
  return E_NOTIMPL;
}

HRESULT MediaSourceActivate::DetachObject() {
  return E_NOTIMPL;
}

}  // namespace twinscript::vcam
