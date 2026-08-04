#include "dshow_filter.h"

#include <dshow.h>

#include "dshow_guids.h"
#include "dshow_log.h"

namespace twinscript::dshow {
namespace {

// An empty pin enumerator, used until the output pin lands in W6.2.
//
// Returning a working-but-empty enumerator rather than E_NOTIMPL matters: a
// consumer that gets a failure from EnumPins may drop the device from its list
// entirely, which would make the registration milestone untestable.
class EmptyPinEnumerator : public IEnumPins, public RefCounted<EmptyPinEnumerator> {
 public:
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
  TWINSCRIPT_DSHOW_REFCOUNT(EmptyPinEnumerator)

  HRESULT STDMETHODCALLTYPE Next(ULONG count, IPin** pins, ULONG* fetched) override {
    if (!pins) return E_POINTER;
    if (fetched) *fetched = 0;
    // S_FALSE means "fewer than requested", which for an empty set is correct.
    return count == 0 ? S_OK : S_FALSE;
  }
  HRESULT STDMETHODCALLTYPE Skip(ULONG) override { return S_FALSE; }
  HRESULT STDMETHODCALLTYPE Reset() override { return S_OK; }
  HRESULT STDMETHODCALLTYPE Clone(IEnumPins** out) override {
    if (!out) return E_POINTER;
    auto* clone = new (std::nothrow) EmptyPinEnumerator();
    if (!clone) return E_OUTOFMEMORY;
    *out = clone;
    return S_OK;
  }
};

}  // namespace

Filter::Filter() { ::InitializeCriticalSection(&lock_); }

Filter::~Filter() {
  if (clock_) clock_->Release();
  ::DeleteCriticalSection(&lock_);
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
  Lock guard(&lock_);
  LogLine("Filter::Stop");
  state_ = State_Stopped;
  return S_OK;
}

HRESULT Filter::Pause() {
  Lock guard(&lock_);
  LogLine("Filter::Pause");
  state_ = State_Paused;
  return S_OK;
}

HRESULT Filter::Run(REFERENCE_TIME start) {
  Lock guard(&lock_);
  LogLine("Filter::Run start=%lld", static_cast<long long>(start));
  state_ = State_Running;
  return S_OK;
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
  LogLine("Filter::EnumPins (skeleton: no pins yet)");
  auto* created = new (std::nothrow) EmptyPinEnumerator();
  if (!created) return E_OUTOFMEMORY;
  *enumerator = created;
  return S_OK;
}

HRESULT Filter::FindPin(LPCWSTR id, IPin** pin) {
  if (!pin) return E_POINTER;
  *pin = nullptr;
  LogLine("Filter::FindPin '%ls' -> VFW_E_NOT_FOUND (skeleton)", id ? id : L"(null)");
  return VFW_E_NOT_FOUND;
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
