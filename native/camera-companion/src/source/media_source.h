#pragma once

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <ks.h>
#include <ksproxy.h>

#include "com_support.h"
#include "media_stream.h"

namespace bilingual::vcam {

// The virtual camera's media source: one progressive RGB32 video stream.
//
// RGB32 is chosen so no pixel conversion sits between Electron and the consumer
// — the shared-memory frame contract is already BGRA8, which is byte-identical.
// A positive MF_MT_DEFAULT_STRIDE declares top-down rows; RGB32 defaults to
// bottom-up in Media Foundation, and omitting it renders the stage upside down.
class MediaSource : public IMFMediaSourceEx, public IMFGetService, public IKsControl {
 public:
  static HRESULT CreateInstance(IMFAttributes* activationAttributes, MediaSource** out);

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

  // -- IMFMediaSource
  HRESULT STDMETHODCALLTYPE GetCharacteristics(DWORD* characteristics) override;
  HRESULT STDMETHODCALLTYPE CreatePresentationDescriptor(
      IMFPresentationDescriptor** descriptor) override;
  HRESULT STDMETHODCALLTYPE Start(IMFPresentationDescriptor* descriptor,
                                  const GUID* timeFormat,
                                  const PROPVARIANT* startPosition) override;
  HRESULT STDMETHODCALLTYPE Stop() override;
  HRESULT STDMETHODCALLTYPE Pause() override;
  HRESULT STDMETHODCALLTYPE Shutdown() override;

  // -- IMFMediaSourceEx
  HRESULT STDMETHODCALLTYPE GetSourceAttributes(IMFAttributes** attributes) override;
  HRESULT STDMETHODCALLTYPE GetStreamAttributes(DWORD streamId,
                                                IMFAttributes** attributes) override;
  HRESULT STDMETHODCALLTYPE SetD3DManager(IUnknown* manager) override;

  // -- IMFGetService
  HRESULT STDMETHODCALLTYPE GetService(REFGUID service, REFIID iid, LPVOID* out) override;

  // -- IKsControl
  HRESULT STDMETHODCALLTYPE KsProperty(PKSPROPERTY property, ULONG propertyLength,
                                       void* propertyData, ULONG dataLength,
                                       ULONG* bytesReturned) override;
  HRESULT STDMETHODCALLTYPE KsMethod(PKSMETHOD method, ULONG methodLength, void* methodData,
                                     ULONG dataLength, ULONG* bytesReturned) override;
  HRESULT STDMETHODCALLTYPE KsEvent(PKSEVENT event, ULONG eventLength, void* eventData,
                                    ULONG dataLength, ULONG* bytesReturned) override;

 private:
  MediaSource();
  ~MediaSource();

  HRESULT Initialize();
  HRESULT CheckShutdown() const { return shutdown_ ? MF_E_SHUTDOWN : S_OK; }

  LONG ref_count_ = 1;
  CRITICAL_SECTION lock_{};
  bool shutdown_ = false;
  bool started_ = false;

  ComPtr<IMFMediaEventQueue> event_queue_;
  ComPtr<IMFPresentationDescriptor> presentation_descriptor_;
  ComPtr<IMFAttributes> source_attributes_;
  ComPtr<IMFAttributes> stream_attributes_;
  ComPtr<MediaStream> stream_;
};

}  // namespace bilingual::vcam
