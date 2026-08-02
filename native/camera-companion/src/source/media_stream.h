#pragma once

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <ks.h>
#include <ksproxy.h>

#include "com_support.h"
#include "frame_source.h"

namespace bilingual::vcam {

class MediaSource;

// The single video stream of the virtual camera.
//
// Media Foundation's pull model: the consumer calls RequestSample, and the
// stream answers asynchronously by queueing an MEMediaSample event carrying an
// IMFSample. Frames are never pushed.
class MediaStream : public IMFMediaStream2, public IKsControl {
 public:
  static HRESULT Create(MediaSource* parent, IMFStreamDescriptor* descriptor,
                        MediaStream** out);

  // -- IUnknown
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override;
  ULONG STDMETHODCALLTYPE AddRef() override;
  ULONG STDMETHODCALLTYPE Release() override;

  // -- IMFMediaEventGenerator
  HRESULT STDMETHODCALLTYPE GetEvent(DWORD flags, IMFMediaEvent** event) override;
  HRESULT STDMETHODCALLTYPE BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override;
  HRESULT STDMETHODCALLTYPE EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) override;
  HRESULT STDMETHODCALLTYPE QueueEvent(MediaEventType type, REFGUID extendedType,
                                       HRESULT status, const PROPVARIANT* value) override;

  // -- IMFMediaStream
  HRESULT STDMETHODCALLTYPE GetMediaSource(IMFMediaSource** source) override;
  HRESULT STDMETHODCALLTYPE GetStreamDescriptor(IMFStreamDescriptor** descriptor) override;
  HRESULT STDMETHODCALLTYPE RequestSample(IUnknown* token) override;

  // -- IMFMediaStream2
  HRESULT STDMETHODCALLTYPE SetStreamState(MF_STREAM_STATE state) override;
  HRESULT STDMETHODCALLTYPE GetStreamState(MF_STREAM_STATE* state) override;

  // -- IKsControl (the frame server probes for it; no controls are exposed)
  HRESULT STDMETHODCALLTYPE KsProperty(PKSPROPERTY property, ULONG propertyLength,
                                       void* propertyData, ULONG dataLength,
                                       ULONG* bytesReturned) override;
  HRESULT STDMETHODCALLTYPE KsMethod(PKSMETHOD method, ULONG methodLength, void* methodData,
                                     ULONG dataLength, ULONG* bytesReturned) override;
  HRESULT STDMETHODCALLTYPE KsEvent(PKSEVENT event, ULONG eventLength, void* eventData,
                                    ULONG dataLength, ULONG* bytesReturned) override;

  // -- called by MediaSource
  HRESULT Start();
  HRESULT Stop();
  HRESULT Shutdown();
  IMFMediaEventQueue* EventQueue() const { return event_queue_.Get(); }

 private:
  MediaStream();
  ~MediaStream();

  HRESULT CheckShutdown() const {
    return shutdown_ ? MF_E_SHUTDOWN : S_OK;
  }
  HRESULT DeliverSample(IUnknown* token);
  // The pixel layout the consumer most recently selected.
  OutputFormat CurrentFormat() const;

  LONG ref_count_ = 1;
  CRITICAL_SECTION lock_{};
  bool shutdown_ = false;
  MF_STREAM_STATE state_ = MF_STREAM_STATE_STOPPED;

  // Weak by design: the source owns the stream, so a strong reference here
  // would be a cycle that never releases.
  MediaSource* parent_ = nullptr;

  ComPtr<IMFStreamDescriptor> descriptor_;
  ComPtr<IMFMediaEventQueue> event_queue_;
  FrameSource frames_;
};

}  // namespace bilingual::vcam
