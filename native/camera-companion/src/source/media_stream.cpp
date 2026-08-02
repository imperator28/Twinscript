#include "media_stream.h"

#include <new>
#include <vector>

#include "media_source.h"
#include "module_lifetime.h"
#include "vcam_log.h"

namespace bilingual::vcam {

MediaStream::MediaStream() {
  ModuleObjectCreated();
  ::InitializeCriticalSection(&lock_);
}

MediaStream::~MediaStream() {
  ::DeleteCriticalSection(&lock_);
  ModuleObjectDestroyed();
}

HRESULT MediaStream::Create(MediaSource* parent, IMFStreamDescriptor* descriptor,
                            MediaStream** out) {
  if (!parent || !descriptor || !out) return E_POINTER;
  *out = nullptr;

  MediaStream* stream = new (std::nothrow) MediaStream();
  if (!stream) return E_OUTOFMEMORY;

  stream->parent_ = parent;
  stream->descriptor_ = descriptor;

  HRESULT hr = ::MFCreateEventQueue(stream->event_queue_.GetAddressOf());
  if (FAILED(hr)) {
    stream->Release();
    return hr;
  }

  // Mirror the negotiated format so sample production cannot drift from what the
  // stream descriptor advertises.
  ComPtr<IMFMediaTypeHandler> handler;
  hr = descriptor->GetMediaTypeHandler(handler.GetAddressOf());
  if (FAILED(hr)) {
    stream->Release();
    return hr;
  }
  ComPtr<IMFMediaType> media_type;
  hr = handler->GetCurrentMediaType(media_type.GetAddressOf());
  if (FAILED(hr)) {
    stream->Release();
    return hr;
  }
  UINT32 width = 0, height = 0, numerator = 0, denominator = 0;
  ::MFGetAttributeSize(media_type.Get(), MF_MT_FRAME_SIZE, &width, &height);
  ::MFGetAttributeRatio(media_type.Get(), MF_MT_FRAME_RATE, &numerator, &denominator);
  stream->frames_.Configure(width, height, denominator ? numerator / denominator : 0);

  *out = stream;
  return S_OK;
}

HRESULT MediaStream::QueryInterface(REFIID iid, void** out) {
  if (!out) return E_POINTER;
  *out = nullptr;
  if (iid == __uuidof(IUnknown)) {
    *out = static_cast<IMFMediaStream2*>(this);
  } else if (iid == __uuidof(IMFMediaEventGenerator)) {
    *out = static_cast<IMFMediaEventGenerator*>(this);
  } else if (iid == __uuidof(IMFMediaStream)) {
    *out = static_cast<IMFMediaStream*>(this);
  } else if (iid == __uuidof(IMFMediaStream2)) {
    *out = static_cast<IMFMediaStream2*>(this);
  } else if (iid == __uuidof(IKsControl)) {
    *out = static_cast<IKsControl*>(this);
  } else {
    return E_NOINTERFACE;
  }
  AddRef();
  return S_OK;
}

ULONG MediaStream::AddRef() { return ::InterlockedIncrement(&ref_count_); }

ULONG MediaStream::Release() {
  const ULONG remaining = ::InterlockedDecrement(&ref_count_);
  if (remaining == 0) delete this;
  return remaining;
}

HRESULT MediaStream::GetEvent(DWORD flags, IMFMediaEvent** event) {
  ComPtr<IMFMediaEventQueue> queue;
  {
    Lock guard(&lock_);
    HRESULT hr = CheckShutdown();
    if (FAILED(hr)) return hr;
    queue = event_queue_;
  }
  // Outside the lock: GetEvent can block, and holding the lock would deadlock
  // against whichever thread wants to queue the event being waited for.
  return queue->GetEvent(flags, event);
}

HRESULT MediaStream::BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) {
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  return event_queue_->BeginGetEvent(callback, state);
}

HRESULT MediaStream::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) {
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  return event_queue_->EndGetEvent(result, event);
}

HRESULT MediaStream::QueueEvent(MediaEventType type, REFGUID extendedType, HRESULT status,
                                const PROPVARIANT* value) {
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  return event_queue_->QueueEventParamVar(type, extendedType, status, value);
}

HRESULT MediaStream::GetMediaSource(IMFMediaSource** source) {
  if (!source) return E_POINTER;
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  if (!parent_) return E_UNEXPECTED;
  return parent_->QueryInterface(__uuidof(IMFMediaSource), reinterpret_cast<void**>(source));
}

HRESULT MediaStream::GetStreamDescriptor(IMFStreamDescriptor** descriptor) {
  if (!descriptor) return E_POINTER;
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  *descriptor = descriptor_.Get();
  (*descriptor)->AddRef();
  return S_OK;
}

HRESULT MediaStream::RequestSample(IUnknown* token) {
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) {
    LogLine("MediaStream::RequestSample shutdown hr=0x%08lX", hr);
    return hr;
  }
  LogLine("MediaStream::RequestSample state=%u", static_cast<unsigned>(state_));
  if (state_ != MF_STREAM_STATE_RUNNING) return MF_E_INVALIDREQUEST;
  hr = DeliverSample(token);
  LogLine("MediaStream::DeliverSample hr=0x%08lX", hr);
  return hr;
}

HRESULT MediaStream::DeliverSample(IUnknown* token) {
  // Read the negotiated format per sample rather than caching it: the consumer
  // can call SetCurrentMediaType on the descriptor's handler at any time, and
  // this stream is not notified when it does. One COM call is negligible beside
  // the per-frame conversion.
  const OutputFormat format = CurrentFormat();
  const DWORD payload_bytes = static_cast<DWORD>(frames_.PayloadBytesFor(format));

  ComPtr<IMFMediaBuffer> buffer;
  const DWORD fourcc = format == OutputFormat::kNv12 ? MFVideoFormat_NV12.Data1
                                                      : MFVideoFormat_RGB32.Data1;
  HRESULT hr = ::MFCreate2DMediaBuffer(frames_.Width(), frames_.Height(), fourcc, FALSE,
                                       buffer.GetAddressOf());
  if (FAILED(hr)) return hr;

  std::vector<BYTE> contiguous(payload_bytes);
  frames_.WaitForFrameDeadline();
  frames_.WriteFrame(contiguous.data(), format);
  ComPtr<IMF2DBuffer> buffer2d;
  hr = buffer.As(&buffer2d);
  if (FAILED(hr)) return hr;
  hr = buffer2d->ContiguousCopyFrom(contiguous.data(), payload_bytes);
  if (FAILED(hr)) return hr;
  hr = buffer->SetCurrentLength(payload_bytes);
  if (FAILED(hr)) return hr;

  ComPtr<IMFSample> sample;
  hr = ::MFCreateSample(sample.GetAddressOf());
  if (FAILED(hr)) return hr;
  hr = sample->AddBuffer(buffer.Get());
  if (FAILED(hr)) return hr;
  hr = sample->SetSampleTime(frames_.TakeTimestamp());
  if (FAILED(hr)) return hr;
  hr = sample->SetSampleDuration(frames_.FrameDuration());
  if (FAILED(hr)) return hr;

  // The token round-trips so the caller can correlate its request with this
  // sample; MF requires it be attached when one was supplied.
  if (token) {
    hr = sample->SetUnknown(MFSampleExtension_Token, token);
    if (FAILED(hr)) return hr;
  }

  return event_queue_->QueueEventParamUnk(MEMediaSample, GUID_NULL, S_OK, sample.Get());
}

OutputFormat MediaStream::CurrentFormat() const {
  ComPtr<IMFMediaTypeHandler> handler;
  if (!descriptor_ ||
      FAILED(descriptor_->GetMediaTypeHandler(handler.GetAddressOf()))) {
    return OutputFormat::kNv12;
  }
  ComPtr<IMFMediaType> media_type;
  if (FAILED(handler->GetCurrentMediaType(media_type.GetAddressOf()))) {
    return OutputFormat::kNv12;
  }
  GUID subtype = GUID_NULL;
  if (FAILED(media_type->GetGUID(MF_MT_SUBTYPE, &subtype))) return OutputFormat::kNv12;
  return subtype == MFVideoFormat_RGB32 ? OutputFormat::kRgb32 : OutputFormat::kNv12;
}

HRESULT MediaStream::SetStreamState(MF_STREAM_STATE state) {
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  switch (state) {
    case MF_STREAM_STATE_PAUSED:
      // Paused keeps the timeline; only RUNNING resumes delivery.
      state_ = MF_STREAM_STATE_PAUSED;
      return S_OK;
    case MF_STREAM_STATE_RUNNING:
      state_ = MF_STREAM_STATE_RUNNING;
      return S_OK;
    case MF_STREAM_STATE_STOPPED:
      state_ = MF_STREAM_STATE_STOPPED;
      frames_.Reset();
      return S_OK;
    default:
      return E_INVALIDARG;
  }
}

HRESULT MediaStream::GetStreamState(MF_STREAM_STATE* state) {
  if (!state) return E_POINTER;
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  *state = state_;
  return S_OK;
}

HRESULT MediaStream::KsProperty(PKSPROPERTY, ULONG, void*, ULONG, ULONG*) {
  return E_NOTIMPL;
}
HRESULT MediaStream::KsMethod(PKSMETHOD, ULONG, void*, ULONG, ULONG*) { return E_NOTIMPL; }
HRESULT MediaStream::KsEvent(PKSEVENT, ULONG, void*, ULONG, ULONG*) { return E_NOTIMPL; }

HRESULT MediaStream::Start() {
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  state_ = MF_STREAM_STATE_RUNNING;
  LogLine("MediaStream::Start state=running");
  return event_queue_->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr);
}

HRESULT MediaStream::Stop() {
  Lock guard(&lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  state_ = MF_STREAM_STATE_STOPPED;
  frames_.Reset();
  return event_queue_->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr);
}

HRESULT MediaStream::Shutdown() {
  Lock guard(&lock_);
  if (shutdown_) return S_OK;
  shutdown_ = true;
  state_ = MF_STREAM_STATE_STOPPED;
  if (event_queue_) event_queue_->Shutdown();
  event_queue_.Reset();
  descriptor_.Reset();
  parent_ = nullptr;
  return S_OK;
}

}  // namespace bilingual::vcam
