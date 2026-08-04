#include "dshow_filter.h"

#include <dshow.h>

#include "dshow_guids.h"
#include "dshow_log.h"
#include "dshow_pin.h"

namespace twinscript::dshow {
namespace {

// Single-pin enumerator. A consumer walks this to find the capture pin, so
// getting it wrong makes the camera enumerate and then fail to connect - which is
// exactly what the skeleton did, and what Teams reported as
// "camera is in use by another application".
class PinEnumerator : public IEnumPins, public RefCounted<PinEnumerator> {
 public:
  PinEnumerator(IPin* pin, ULONG position) : pin_(pin), position_(position) {
    if (pin_) pin_->AddRef();
  }

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
    if (!out) return E_POINTER;
    if (iid == IID_IUnknown || iid == IID_IEnumPins) {
      *out = static_cast<IEnumPins*>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  TWINSCRIPT_DSHOW_REFCOUNT(PinEnumerator)

  HRESULT STDMETHODCALLTYPE Next(ULONG count, IPin** pins, ULONG* fetched) override {
    if (!pins) return E_POINTER;
    ULONG produced = 0;
    while (produced < count && position_ == 0 && pin_) {
      pin_->AddRef();
      pins[produced++] = pin_;
      position_ = 1;
    }
    if (fetched) *fetched = produced;
    return produced == count ? S_OK : S_FALSE;
  }
  HRESULT STDMETHODCALLTYPE Skip(ULONG count) override {
    position_ += count;
    return position_ > 1 ? S_FALSE : S_OK;
  }
  HRESULT STDMETHODCALLTYPE Reset() override {
    position_ = 0;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Clone(IEnumPins** out) override {
    if (!out) return E_POINTER;
    auto* clone = new (std::nothrow) PinEnumerator(pin_, position_);
    if (!clone) return E_OUTOFMEMORY;
    *out = clone;
    return S_OK;
  }

 private:
  friend class RefCounted<PinEnumerator>;
  ~PinEnumerator() override {
    if (pin_) pin_->Release();
  }
  IPin* pin_ = nullptr;
  ULONG position_ = 0;
};

}  // namespace

Filter::Filter() { ::InitializeCriticalSection(&lock_); }

Filter::~Filter() {
  if (pin_) {
    pin_->Stop();
    pin_->Release();
    pin_ = nullptr;
  }
  if (clock_) clock_->Release();
  ::DeleteCriticalSection(&lock_);
}

// Created on demand rather than in the constructor so a failure surfaces from the
// call that needs the pin, with a usable HRESULT, instead of from CreateInstance.
HRESULT Filter::EnsurePin() {
  if (pin_) return S_OK;
  OutputPin* pin = nullptr;
  const HRESULT hr = OutputPin::Create(this, &pin);
  if (FAILED(hr)) {
    LogLine("Filter::EnsurePin failed hr=0x%08lX", static_cast<unsigned long>(hr));
    return hr;
  }
  pin_ = pin;
  return S_OK;
}

bool Filter::IsRunning() {
  Lock guard(&lock_);
  return state_ == State_Running;
}

HRESULT Filter::CreateInstance(REFIID iid, void** out) {
  if (!out) return E_POINTER;
  *out = nullptr;
  auto* filter = new (std::nothrow) Filter();
  if (!filter) return E_OUTOFMEMORY;
  const HRESULT hr = filter->QueryInterface(iid, out);
  // Drop the construction reference either way: on success the QI took its own.
  filter->Release();
  return hr;
}

HRESULT Filter::QueryInterface(REFIID iid, void** out) {
  if (!out) return E_POINTER;
  if (iid == IID_IUnknown || iid == IID_IPersist || iid == IID_IMediaFilter ||
      iid == IID_IBaseFilter) {
    *out = static_cast<IBaseFilter*>(this);
  } else if (iid == IID_IAMFilterMiscFlags) {
    *out = static_cast<IAMFilterMiscFlags*>(this);
  } else {
    *out = nullptr;
    // Logged: on the Media Foundation path, not knowing which interfaces a
    // consumer asked for cost several rounds of guessing.
    LogGuid("Filter QueryInterface REFUSED", iid, E_NOINTERFACE);
    return E_NOINTERFACE;
  }
  AddRef();
  return S_OK;
}

HRESULT Filter::GetClassID(CLSID* clsid) {
  if (!clsid) return E_POINTER;
  *clsid = kFilterClsid;
  return S_OK;
}

HRESULT Filter::Stop() {
  OutputPin* pin = nullptr;
  {
    Lock guard(&lock_);
    LogLine("Filter::Stop");
    state_ = State_Stopped;
    pin = pin_;
    if (pin) pin->AddRef();
  }
  // Outside the lock: stopping joins the delivery thread, which takes the pin's
  // lock, and a consumer calling Stop() must not deadlock here.
  if (pin) {
    pin->Stop();
    pin->Release();
  }
  return S_OK;
}

HRESULT Filter::Pause() {
  OutputPin* pin = nullptr;
  {
    Lock guard(&lock_);
    LogLine("Filter::Pause");
    state_ = State_Paused;
    pin = pin_;
    if (pin) pin->AddRef();
  }
  if (pin) {
    pin->Pause();
    pin->Release();
  }
  return S_OK;
}

HRESULT Filter::Run(REFERENCE_TIME start) {
  OutputPin* pin = nullptr;
  {
    Lock guard(&lock_);
    LogLine("Filter::Run start=%lld", static_cast<long long>(start));
    state_ = State_Running;
    pin = pin_;
    if (pin) pin->AddRef();
  }
  if (!pin) return S_OK;
  // An unconnected filter running is legal; there is simply nowhere to push.
  const HRESULT hr = pin->IsConnected() ? pin->Run() : S_OK;
  pin->Release();
  return hr;
}

HRESULT Filter::GetState(DWORD, FILTER_STATE* state) {
  if (!state) return E_POINTER;
  Lock guard(&lock_);
  *state = state_;
  return S_OK;
}

HRESULT Filter::SetSyncSource(IReferenceClock* clock) {
  Lock guard(&lock_);
  if (clock_) clock_->Release();
  clock_ = clock;
  if (clock_) clock_->AddRef();
  return S_OK;
}

HRESULT Filter::GetSyncSource(IReferenceClock** clock) {
  if (!clock) return E_POINTER;
  Lock guard(&lock_);
  *clock = clock_;
  if (*clock) (*clock)->AddRef();
  return S_OK;
}

HRESULT Filter::EnumPins(IEnumPins** enumerator) {
  if (!enumerator) return E_POINTER;
  Lock guard(&lock_);
  const HRESULT hr = EnsurePin();
  if (FAILED(hr)) return hr;
  LogLine("Filter::EnumPins -> 1 pin");
  auto* created = new (std::nothrow) PinEnumerator(static_cast<IPin*>(pin_), 0);
  if (!created) return E_OUTOFMEMORY;
  *enumerator = created;
  return S_OK;
}

HRESULT Filter::FindPin(LPCWSTR id, IPin** pin) {
  if (!pin) return E_POINTER;
  *pin = nullptr;
  Lock guard(&lock_);
  // Matched case-insensitively: the id round-trips through consumers that
  // normalise case, and a mismatch here reads as a missing pin.
  if (!id || ::_wcsicmp(id, L"Capture") != 0) {
    LogLine("Filter::FindPin '%ls' -> VFW_E_NOT_FOUND", id ? id : L"(null)");
    return VFW_E_NOT_FOUND;
  }
  const HRESULT hr = EnsurePin();
  if (FAILED(hr)) return hr;
  *pin = static_cast<IPin*>(pin_);
  (*pin)->AddRef();
  LogLine("Filter::FindPin '%ls' ok", id);
  return S_OK;
}

HRESULT Filter::QueryFilterInfo(FILTER_INFO* info) {
  if (!info) return E_POINTER;
  Lock guard(&lock_);
  ::wcsncpy_s(info->achName, ARRAYSIZE(info->achName), graph_name_[0] ? graph_name_
                                                                      : kFilterName,
              _TRUNCATE);
  // Per the IBaseFilter contract the caller releases this reference.
  info->pGraph = graph_;
  if (info->pGraph) info->pGraph->AddRef();
  return S_OK;
}

HRESULT Filter::JoinFilterGraph(IFilterGraph* graph, LPCWSTR name) {
  Lock guard(&lock_);
  LogLine("Filter::JoinFilterGraph graph=%p name='%ls'", static_cast<void*>(graph),
          name ? name : L"(null)");
  // Stored weakly: holding a reference to the graph that owns us is a cycle.
  graph_ = graph;
  if (name) {
    ::wcsncpy_s(graph_name_, ARRAYSIZE(graph_name_), name, _TRUNCATE);
  } else {
    graph_name_[0] = L'\0';
  }
  return S_OK;
}

HRESULT Filter::QueryVendorInfo(LPWSTR* vendor) {
  // Optional, and returning E_NOTIMPL is the documented way to decline.
  if (vendor) *vendor = nullptr;
  return E_NOTIMPL;
}

ULONG Filter::GetMiscFlags() { return AM_FILTER_MISC_FLAGS_IS_SOURCE; }

}  // namespace twinscript::dshow
