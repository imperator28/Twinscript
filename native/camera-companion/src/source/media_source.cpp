#include "media_source.h"

#include <mfreadwrite.h>
#include <new>

#include "frame_transport.h"
#include "vcam_log.h"
#include "module_lifetime.h"

namespace bilingual::vcam {
namespace {

constexpr DWORD kStreamId = 0;

// PINNAME_VIDEO_CAPTURE from ksmedia.h, spelled out locally. Pulling it in
// properly would require <initguid.h>, which instantiates every GUID in the
// Media Foundation headers as data in this translation unit and collides with
// the definitions already provided by mfuuid.lib.
constexpr GUID kPinNameVideoCapture = {
    0xfb6c4281, 0x0353, 0x11d1, {0x90, 0x5f, 0x00, 0x00, 0xc0, 0xcc, 0x16, 0xba}};

HRESULT CreateVideoMediaType(REFGUID subtype, IMFMediaType** out) {
  using namespace frame_transport;

  ComPtr<IMFMediaType> media_type;
  HRESULT hr = ::MFCreateMediaType(media_type.GetAddressOf());
  if (FAILED(hr)) return hr;

  hr = media_type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  if (FAILED(hr)) return hr;
  hr = media_type->SetGUID(MF_MT_SUBTYPE, subtype);
  if (FAILED(hr)) return hr;
  hr = ::MFSetAttributeSize(media_type.Get(), MF_MT_FRAME_SIZE, kDefaultWidth, kDefaultHeight);
  if (FAILED(hr)) return hr;
  hr = ::MFSetAttributeRatio(media_type.Get(), MF_MT_FRAME_RATE, kDefaultFrameRate, 1);
  if (FAILED(hr)) return hr;
  hr = ::MFSetAttributeRatio(media_type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  if (FAILED(hr)) return hr;
  hr = media_type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  if (FAILED(hr)) return hr;
  // Camera sources must declare independent samples; without it consumers may
  // wait for a key frame that never arrives.
  hr = media_type->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
  if (FAILED(hr)) return hr;
  hr = media_type->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE);
  if (FAILED(hr)) return hr;

  const bool is_nv12 = subtype == MFVideoFormat_NV12;
  // Stride is the Y-plane row for NV12 (one byte per luma sample) and the full
  // BGRA row for RGB32. Positive = top-down; RGB32 is bottom-up by default in
  // MF, which would present the caption stage vertically mirrored.
  const UINT32 stride = is_nv12 ? kDefaultWidth : kDefaultWidth * 4;
  const UINT32 sample_size =
      is_nv12 ? kDefaultWidth * kDefaultHeight * 3 / 2 : kDefaultWidth * 4 * kDefaultHeight;
  hr = media_type->SetUINT32(MF_MT_DEFAULT_STRIDE, stride);
  if (FAILED(hr)) return hr;
  hr = media_type->SetUINT32(MF_MT_SAMPLE_SIZE, sample_size);
  if (FAILED(hr)) return hr;

  *out = media_type.Detach();
  return S_OK;
}

}  // namespace

MediaSource::MediaSource() {
  ModuleObjectCreated();
  ::InitializeCriticalSection(&lock_);
}

MediaSource::~MediaSource() {
  ::DeleteCriticalSection(&lock_);
  ModuleObjectDestroyed();
}

HRESULT MediaSource::CreateInstance(IMFAttributes* activationAttributes, MediaSource** out) {
  if (!out) return E_POINTER;
  *out = nullptr;
  MediaSource* source = new (std::nothrow) MediaSource();
  if (!source) return E_OUTOFMEMORY;
  HRESULT hr = source->Initialize();
  if (FAILED(hr)) {
    source->Release();
    return hr;
  }
  if (activationAttributes) {
    hr = activationAttributes->CopyAllItems(source->source_attributes_.Get());
    if (FAILED(hr)) {
      source->Release();
      return hr;
    }
  }
  *out = source;
  return S_OK;
}

HRESULT MediaSource::Initialize() {
  HRESULT hr = ::MFCreateEventQueue(event_queue_.GetAddressOf());
  if (FAILED(hr)) return hr;

  // NV12 first: the camera pipeline picks the first acceptable type, and a
  // source offering only RGB32 is invalidated before it ever streams.
  ComPtr<IMFMediaType> nv12_type;
  hr = CreateVideoMediaType(MFVideoFormat_NV12, nv12_type.GetAddressOf());
  if (FAILED(hr)) return hr;
  ComPtr<IMFMediaType> rgb32_type;
  hr = CreateVideoMediaType(MFVideoFormat_RGB32, rgb32_type.GetAddressOf());
  if (FAILED(hr)) return hr;

  IMFMediaType* types[] = {nv12_type.Get(), rgb32_type.Get()};
  ComPtr<IMFStreamDescriptor> stream_descriptor;
  hr = ::MFCreateStreamDescriptor(kStreamId, ARRAYSIZE(types), types,
                                  stream_descriptor.GetAddressOf());
  if (FAILED(hr)) return hr;

  // A stream descriptor starts with no current type; select the preferred one.
  ComPtr<IMFMediaTypeHandler> handler;
  hr = stream_descriptor->GetMediaTypeHandler(handler.GetAddressOf());
  if (FAILED(hr)) return hr;
  hr = handler->SetCurrentMediaType(nv12_type.Get());
  if (FAILED(hr)) return hr;

  IMFStreamDescriptor* descriptors[] = {stream_descriptor.Get()};
  hr = ::MFCreatePresentationDescriptor(1, descriptors,
                                        presentation_descriptor_.GetAddressOf());
  if (FAILED(hr)) return hr;
  hr = presentation_descriptor_->SelectStream(0);
  if (FAILED(hr)) return hr;

  hr = ::MFCreateAttributes(source_attributes_.GetAddressOf(), 4);
  if (FAILED(hr)) return hr;
  // Declaring the source as a colour camera keeps the frame server from
  // inserting transforms that assume a depth or IR sensor. This attribute is a
  // UINT32 bitmask of MFFrameSourceTypes, not a GUID.
  hr = source_attributes_->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES,
                                     MFFrameSourceTypes_Color);
  if (FAILED(hr)) return hr;

  hr = ::MFCreateAttributes(stream_attributes_.GetAddressOf(), 4);
  if (FAILED(hr)) return hr;
  hr = stream_attributes_->SetUINT32(MF_DEVICESTREAM_STREAM_ID, kStreamId);
  if (FAILED(hr)) return hr;
  hr = stream_attributes_->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, kPinNameVideoCapture);
  if (FAILED(hr)) return hr;

  MediaStream* raw_stream = nullptr;
  hr = MediaStream::Create(this, stream_descriptor.Get(), &raw_stream);
  if (FAILED(hr)) return hr;
  stream_.Attach(raw_stream);
  return S_OK;
}

HRESULT MediaSource::QueryInterface(REFIID iid, void** out) {
  if (!out) return E_POINTER;
  *out = nullptr;
  if (iid == __uuidof(IUnknown)) {
    *out = static_cast<IMFMediaSourceEx*>(this);
  } else if (iid == __uuidof(IMFMediaEventGenerator)) {
    *out = static_cast<IMFMediaEventGenerator*>(this);
  } else if (iid == __uuidof(IMFMediaSource)) {
    *out = static_cast<IMFMediaSource*>(this);
  } else if (iid == __uuidof(IMFMediaSourceEx)) {
    *out = static_cast<IMFMediaSourceEx*>(this);
  } else if (iid == __uuidof(IMFGetService)) {
    *out = static_cast<IMFGetService*>(this);
  } else if (iid == __uuidof(IKsControl)) {
    *out = static_cast<IKsControl*>(this);
  } else {
    // Logged because a refused interface is the most likely cause of an
    // E_NOINTERFACE surfacing out of IMFVirtualCamera::Start, and the frame
    // server gives no other clue about what it asked for.
    LogUnsupportedInterface("MediaSource", iid);
    return E_NOINTERFACE;
  }
  AddRef();
  return S_OK;
}

ULONG MediaSource::AddRef() { return ::InterlockedIncrement(&ref_count_); }

ULONG MediaSource::Release() {
  const ULONG remaining = ::InterlockedDecrement(&ref_count_);
  if (remaining == 0) delete this;
  return remaining;
}

HRESULT MediaSource::GetEvent(DWORD flags, IMFMediaEvent** event) {
  ComPtr<IMFMediaEventQueue> queue;
  {
    Lock guard(&lock_);
    HRESULT hr = CheckShutdown();
    if (FAILED(hr)) return hr;
    queue = event_queue_;
  }
  // Deliberately outside the lock: GetEvent blocks until an event arrives.
  return queue->GetEvent(flags, event);
}

HRESULT MediaSource::BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) {
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  return event_queue_->BeginGetEvent(callback, state);
}

HRESULT MediaSource::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) {
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  return event_queue_->EndGetEvent(result, event);
}

HRESULT MediaSource::QueueEvent(MediaEventType type, REFGUID extendedType, HRESULT status,
                                const PROPVARIANT* value) {
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  return event_queue_->QueueEventParamVar(type, extendedType, status, value);
}

HRESULT MediaSource::GetCharacteristics(DWORD* characteristics) {
  if (!characteristics) return E_POINTER;
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  // A live camera: no seeking, no pausing, no known duration.
  *characteristics = MFMEDIASOURCE_IS_LIVE;
  return S_OK;
}

HRESULT MediaSource::CreatePresentationDescriptor(IMFPresentationDescriptor** descriptor) {
  if (!descriptor) return E_POINTER;
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  // Each caller gets its own clone so selecting streams cannot mutate ours.
  return presentation_descriptor_->Clone(descriptor);
}

HRESULT MediaSource::Start(IMFPresentationDescriptor* descriptor, const GUID* timeFormat,
                           const PROPVARIANT* startPosition) {
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  if (!descriptor) return E_INVALIDARG;
  LogLine("MediaSource::Start entered");
  // Only the default (100ns) time format is meaningful for a live source.
  if (timeFormat && *timeFormat != GUID_NULL) return MF_E_UNSUPPORTED_TIME_FORMAT;

  DWORD stream_count = 0;
  hr = descriptor->GetStreamDescriptorCount(&stream_count);
  if (FAILED(hr)) return hr;
  if (stream_count != 1) return MF_E_UNSUPPORTED_REPRESENTATION;

  BOOL selected = FALSE;
  ComPtr<IMFStreamDescriptor> requested;
  hr = descriptor->GetStreamDescriptorByIndex(0, &selected, requested.GetAddressOf());
  if (FAILED(hr)) return hr;
  if (!selected) return MF_E_UNSUPPORTED_REPRESENTATION;

  PROPVARIANT start_time;
  ::PropVariantInit(&start_time);
  if (startPosition && startPosition->vt == VT_I8) {
    start_time.vt = VT_I8;
    start_time.hVal.QuadPart = startPosition->hVal.QuadPart;
  } else {
    // A live source ignores the requested position; report the current one.
    start_time.vt = VT_I8;
    start_time.hVal.QuadPart = 0;
  }

  // The consumer must learn about the stream before the source reports started,
  // or it has nowhere to send RequestSample. MENewStream on a first start,
  // MEUpdatedStream on a restart.
  const MediaEventType stream_event = started_ ? MEUpdatedStream : MENewStream;
  ComPtr<IUnknown> stream_unknown;
  hr = stream_->QueryInterface(__uuidof(IUnknown),
                              reinterpret_cast<void**>(stream_unknown.GetAddressOf()));
  if (FAILED(hr)) {
    ::PropVariantClear(&start_time);
    return hr;
  }
  hr = event_queue_->QueueEventParamUnk(stream_event, GUID_NULL, S_OK, stream_unknown.Get());
  if (FAILED(hr)) {
    ::PropVariantClear(&start_time);
    return hr;
  }

  hr = stream_->Start();
  if (FAILED(hr)) {
    ::PropVariantClear(&start_time);
    return hr;
  }
  LogLine("MediaSource::Start stream started");

  hr = event_queue_->QueueEventParamVar(MESourceStarted, GUID_NULL, S_OK, &start_time);
  ::PropVariantClear(&start_time);
  if (FAILED(hr)) return hr;

  started_ = true;
  LogLine("MediaSource::Start source started");
  return S_OK;
}

HRESULT MediaSource::Stop() {
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  hr = stream_->Stop();
  if (FAILED(hr)) return hr;
  return event_queue_->QueueEventParamVar(MESourceStopped, GUID_NULL, S_OK, nullptr);
}

HRESULT MediaSource::Pause() {
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  // MFMEDIASOURCE_IS_LIVE sources are not required to support Pause, and a
  // paused camera would silently stall the meeting feed.
  return MF_E_INVALID_STATE_TRANSITION;
}

HRESULT MediaSource::Shutdown() {
  Lock guard(&lock_);
  if (shutdown_) return S_OK;
  shutdown_ = true;
  if (stream_) stream_->Shutdown();
  if (event_queue_) event_queue_->Shutdown();
  stream_.Reset();
  event_queue_.Reset();
  presentation_descriptor_.Reset();
  source_attributes_.Reset();
  stream_attributes_.Reset();
  return S_OK;
}

HRESULT MediaSource::GetSourceAttributes(IMFAttributes** attributes) {
  if (!attributes) return E_POINTER;
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  *attributes = source_attributes_.Get();
  (*attributes)->AddRef();
  return S_OK;
}

HRESULT MediaSource::GetStreamAttributes(DWORD streamId, IMFAttributes** attributes) {
  if (!attributes) return E_POINTER;
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  if (streamId != kStreamId) return MF_E_INVALIDSTREAMNUMBER;
  *attributes = stream_attributes_.Get();
  (*attributes)->AddRef();
  return S_OK;
}

HRESULT MediaSource::SetD3DManager(IUnknown*) {
  // Frames are produced on the CPU; there is no D3D surface path to configure.
  return E_NOTIMPL;
}

HRESULT MediaSource::GetService(REFGUID, REFIID iid, LPVOID* out) {
  if (!out) return E_POINTER;
  *out = nullptr;
  // Only interfaces this object itself implements are offered through
  // IMFGetService; there is no inner service object to delegate to.
  const HRESULT hr = QueryInterface(iid, out);
  return SUCCEEDED(hr) ? hr : MF_E_UNSUPPORTED_SERVICE;
}

HRESULT MediaSource::KsProperty(PKSPROPERTY, ULONG, void*, ULONG, ULONG*) {
  return E_NOTIMPL;
}
HRESULT MediaSource::KsMethod(PKSMETHOD, ULONG, void*, ULONG, ULONG*) { return E_NOTIMPL; }
HRESULT MediaSource::KsEvent(PKSEVENT, ULONG, void*, ULONG, ULONG*) { return E_NOTIMPL; }

}  // namespace bilingual::vcam
