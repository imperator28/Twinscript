// The DirectShow source filter itself.
//
// A capture source is a filter with one output pin. This header declares the
// filter; the pin arrives with W6.2, when the streaming contract is proven with a
// trivial frame source before the real one is wired in.
//
// Scope of the skeleton: a consumer must be able to instantiate this filter, query
// it, and see it in a camera list. That is deliberately separable from delivering
// frames, because the Media Foundation attempt failed partly by never having a
// milestone that could be checked on its own.

#pragma once

#include <windows.h>
#include <strmif.h>

#include "dshow_object.h"

namespace twinscript::dshow {

class Filter : public IBaseFilter, public IAMFilterMiscFlags, public RefCounted<Filter> {
 public:
  static HRESULT CreateInstance(REFIID iid, void** out);

  // -- IUnknown
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override;
  TWINSCRIPT_DSHOW_REFCOUNT(Filter)

  // -- IPersist
  HRESULT STDMETHODCALLTYPE GetClassID(CLSID* clsid) override;

  // -- IMediaFilter
  HRESULT STDMETHODCALLTYPE Stop() override;
  HRESULT STDMETHODCALLTYPE Pause() override;
  HRESULT STDMETHODCALLTYPE Run(REFERENCE_TIME start) override;
  HRESULT STDMETHODCALLTYPE GetState(DWORD milliseconds,
                                     FILTER_STATE* state) override;
  HRESULT STDMETHODCALLTYPE SetSyncSource(IReferenceClock* clock) override;
  HRESULT STDMETHODCALLTYPE GetSyncSource(IReferenceClock** clock) override;

  // -- IBaseFilter
  HRESULT STDMETHODCALLTYPE EnumPins(IEnumPins** enumerator) override;
  HRESULT STDMETHODCALLTYPE FindPin(LPCWSTR id, IPin** pin) override;
  HRESULT STDMETHODCALLTYPE QueryFilterInfo(FILTER_INFO* info) override;
  HRESULT STDMETHODCALLTYPE JoinFilterGraph(IFilterGraph* graph, LPCWSTR name) override;
  HRESULT STDMETHODCALLTYPE QueryVendorInfo(LPWSTR* vendor) override;

  // -- IAMFilterMiscFlags
  // Declares this filter a source. Without it some graph builders treat the
  // filter as a transform and never ask it to produce anything.
  ULONG STDMETHODCALLTYPE GetMiscFlags() override;

 private:
  // Lifetime is the reference count's alone; see RefCounted.
  friend class RefCounted<Filter>;

  Filter();
  ~Filter() override;

  CRITICAL_SECTION lock_{};
  FILTER_STATE state_ = State_Stopped;
  IReferenceClock* clock_ = nullptr;
  // Weak by design: the graph owns the filter, so a strong reference here would
  // be a cycle the graph can never break.
  IFilterGraph* graph_ = nullptr;
  wchar_t graph_name_[MAX_FILTER_NAME] = {};
};

}  // namespace twinscript::dshow
