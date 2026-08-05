// The filter's single output pin: a push source.
//
// The consumer's own trace told us which interfaces it wants. From
// ms-teams.exe, Slack.exe and chrome.exe, all of which loaded the filter into
// their own process:
//
//   Filter QueryInterface REFUSED {37D84F60-...}   IAMStreamConfig
//   Filter QueryInterface REFUSED {720D4AC0-...}   IAMVideoProcAmp
//   Filter::EnumPins (skeleton: no pins yet)
//
// so the pin implements IAMStreamConfig, and the filter now returns a real pin.
// IAMVideoProcAmp is brightness/contrast control: declining it is correct for a
// synthetic source and clients accept that, so it stays unimplemented.
//
// A push source owns its own clock: a worker thread allocates a buffer from the
// downstream allocator, fills it, timestamps it, and calls IMemInputPin::Receive.
// Nothing pulls from us.

#pragma once

#include <windows.h>
#include <strmif.h>
#include <amvideo.h>
#include <ks.h>
#include <ksmedia.h>

#include "dshow_object.h"
#include "mapped_frame_reader.h"

namespace twinscript::dshow {

class Filter;

class OutputPin : public IPin,
                  public IAMStreamConfig,
                  public IKsPropertySet,
                  public IQualityControl,
                  public RefCounted<OutputPin> {
 public:
  static HRESULT Create(Filter* owner, OutputPin** out);

  // -- IUnknown
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override;
  TWINSCRIPT_DSHOW_REFCOUNT(OutputPin)

  // -- IPin
  HRESULT STDMETHODCALLTYPE Connect(IPin* receive, const AM_MEDIA_TYPE* media) override;
  HRESULT STDMETHODCALLTYPE ReceiveConnection(IPin* connector,
                                              const AM_MEDIA_TYPE* media) override;
  HRESULT STDMETHODCALLTYPE Disconnect() override;
  HRESULT STDMETHODCALLTYPE ConnectedTo(IPin** pin) override;
  HRESULT STDMETHODCALLTYPE ConnectionMediaType(AM_MEDIA_TYPE* media) override;
  HRESULT STDMETHODCALLTYPE QueryPinInfo(PIN_INFO* info) override;
  HRESULT STDMETHODCALLTYPE QueryDirection(PIN_DIRECTION* direction) override;
  HRESULT STDMETHODCALLTYPE QueryId(LPWSTR* id) override;
  HRESULT STDMETHODCALLTYPE QueryAccept(const AM_MEDIA_TYPE* media) override;
  HRESULT STDMETHODCALLTYPE EnumMediaTypes(IEnumMediaTypes** enumerator) override;
  HRESULT STDMETHODCALLTYPE QueryInternalConnections(IPin** pins, ULONG* count) override;
  HRESULT STDMETHODCALLTYPE EndOfStream() override;
  HRESULT STDMETHODCALLTYPE BeginFlush() override;
  HRESULT STDMETHODCALLTYPE EndFlush() override;
  HRESULT STDMETHODCALLTYPE NewSegment(REFERENCE_TIME start, REFERENCE_TIME stop,
                                       double rate) override;

  // -- IAMStreamConfig
  HRESULT STDMETHODCALLTYPE SetFormat(AM_MEDIA_TYPE* media) override;
  HRESULT STDMETHODCALLTYPE GetFormat(AM_MEDIA_TYPE** media) override;
  HRESULT STDMETHODCALLTYPE GetNumberOfCapabilities(int* count, int* size) override;
  HRESULT STDMETHODCALLTYPE GetStreamCaps(int index, AM_MEDIA_TYPE** media,
                                          BYTE* caps) override;

  // -- IKsPropertySet
  // Only one property matters: a client asks the pin which category it is, and a
  // pin that cannot answer PIN_CATEGORY_CAPTURE is not treated as a capture pin.
  HRESULT STDMETHODCALLTYPE Set(REFGUID set, DWORD id, void* instance,
                                DWORD instance_length, void* data,
                                DWORD data_length) override;
  HRESULT STDMETHODCALLTYPE Get(REFGUID set, DWORD id, void* instance,
                                DWORD instance_length, void* data, DWORD data_length,
                                DWORD* returned) override;
  HRESULT STDMETHODCALLTYPE QuerySupported(REFGUID set, DWORD id,
                                           DWORD* support) override;

  // -- IQualityControl
  // A live source cannot slow down or drop on request, so quality messages are
  // accepted and ignored rather than refused: refusing makes some graphs retry.
  HRESULT STDMETHODCALLTYPE Notify(IBaseFilter* sender, Quality quality) override;
  HRESULT STDMETHODCALLTYPE SetSink(IQualityControl* sink) override;

  // -- called by the filter
  HRESULT Run();
  HRESULT Pause();
  HRESULT Stop();
  bool IsConnected();

 private:
  friend class RefCounted<OutputPin>;

  OutputPin();
  ~OutputPin() override;

  static DWORD WINAPI ThreadEntry(LPVOID context);
  void DeliverLoop();
  HRESULT NegotiateAllocator(IMemInputPin* input);

  // Copy the newest published stage frame into `destination`, or paint the
  // disconnected slate when there is nothing live to show. Returns false when the
  // caller should reuse whatever is already in the buffer.
  bool FillFrame(BYTE* destination, long capacity);
  void PaintSlate(BYTE* destination, long capacity);

  CRITICAL_SECTION lock_{};
  // Weak: the filter owns the pin, so a strong reference would be a cycle.
  Filter* owner_ = nullptr;

  IPin* peer_ = nullptr;
  IMemInputPin* input_ = nullptr;
  IMemAllocator* allocator_ = nullptr;
  IQualityControl* quality_sink_ = nullptr;

  HANDLE thread_ = nullptr;
  HANDLE stop_event_ = nullptr;
  bool flushing_ = false;
  long long frame_index_ = 0;

  // Owned by the delivery thread alone, so it needs no lock: the thread is
  // created after and joined before anything else touches these.
  vcam::MappedFrameReader reader_;
  uint64_t last_open_attempt_ns_ = 0;
  vcam::FrameReadStatus last_status_ = vcam::FrameReadStatus::kInvalid;
};

// Fill in the one media type this pin offers. Exposed so the filter's
// registration and the pin agree on a single definition.
void BuildMediaType(AM_MEDIA_TYPE* media, VIDEOINFOHEADER* header);

}  // namespace twinscript::dshow
