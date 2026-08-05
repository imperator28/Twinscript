#include "dshow_pin.h"

#include <dshow.h>
#include <dvdmedia.h>
#include <cstring>
#include <string>

#include "dshow_filter.h"
#include "dshow_guids.h"
#include "dshow_log.h"

namespace twinscript::dshow {
namespace {

constexpr wchar_t kPinId[] = L"Capture";
constexpr DWORD kFrameBytes = kFrameWidth * kFrameHeight * 4;

// Depth of the downstream buffer pool. Two is the documented minimum for a live
// source; three lets the consumer hold one while we fill the next without the
// allocator blocking every frame.
constexpr long kBufferCount = 3;

void FreeMediaTypeContents(AM_MEDIA_TYPE* media) {
  if (!media) return;
  if (media->cbFormat && media->pbFormat) {
    ::CoTaskMemFree(media->pbFormat);
    media->pbFormat = nullptr;
    media->cbFormat = 0;
  }
  if (media->pUnk) {
    media->pUnk->Release();
    media->pUnk = nullptr;
  }
}

// Allocate a copy a caller will free with CoTaskMemFree, which is what every
// IAMStreamConfig and IEnumMediaTypes caller expects.
AM_MEDIA_TYPE* AllocMediaType() {
  auto* media = static_cast<AM_MEDIA_TYPE*>(::CoTaskMemAlloc(sizeof(AM_MEDIA_TYPE)));
  if (!media) return nullptr;
  ::ZeroMemory(media, sizeof(AM_MEDIA_TYPE));
  auto* header =
      static_cast<VIDEOINFOHEADER*>(::CoTaskMemAlloc(sizeof(VIDEOINFOHEADER)));
  if (!header) {
    ::CoTaskMemFree(media);
    return nullptr;
  }
  ::ZeroMemory(header, sizeof(VIDEOINFOHEADER));
  BuildMediaType(media, header);
  media->cbFormat = sizeof(VIDEOINFOHEADER);
  media->pbFormat = reinterpret_cast<BYTE*>(header);
  return media;
}

bool MediaTypeAcceptable(const AM_MEDIA_TYPE* media) {
  if (!media) return false;
  if (media->majortype != MEDIATYPE_Video) return false;
  if (media->subtype != MEDIASUBTYPE_RGB32) return false;
  if (media->formattype != FORMAT_VideoInfo) return false;
  if (!media->pbFormat || media->cbFormat < sizeof(VIDEOINFOHEADER)) return false;
  const auto* header = reinterpret_cast<const VIDEOINFOHEADER*>(media->pbFormat);
  // Only the one size is offered, so accepting anything else would promise frames
  // this source cannot produce.
  return header->bmiHeader.biWidth == kFrameWidth &&
         ::abs(header->bmiHeader.biHeight) == kFrameHeight;
}

// A single-entry media type enumerator.
class MediaTypeEnumerator : public IEnumMediaTypes,
                            public RefCounted<MediaTypeEnumerator> {
 public:
  explicit MediaTypeEnumerator(ULONG position) : position_(position) {}

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
    if (!out) return E_POINTER;
    if (iid == IID_IUnknown || iid == IID_IEnumMediaTypes) {
      *out = static_cast<IEnumMediaTypes*>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  TWINSCRIPT_DSHOW_REFCOUNT(MediaTypeEnumerator)

  HRESULT STDMETHODCALLTYPE Next(ULONG count, AM_MEDIA_TYPE** types,
                                 ULONG* fetched) override {
    if (!types) return E_POINTER;
    ULONG produced = 0;
    while (produced < count && position_ == 0) {
      AM_MEDIA_TYPE* media = AllocMediaType();
      if (!media) break;
      types[produced++] = media;
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
  HRESULT STDMETHODCALLTYPE Clone(IEnumMediaTypes** out) override {
    if (!out) return E_POINTER;
    auto* clone = new (std::nothrow) MediaTypeEnumerator(position_);
    if (!clone) return E_OUTOFMEMORY;
    *out = clone;
    return S_OK;
  }

 private:
  friend class RefCounted<MediaTypeEnumerator>;
  ~MediaTypeEnumerator() override = default;
  ULONG position_ = 0;
};

}  // namespace

void BuildMediaType(AM_MEDIA_TYPE* media, VIDEOINFOHEADER* header) {
  header->rcSource = {0, 0, kFrameWidth, kFrameHeight};
  header->rcTarget = header->rcSource;
  header->dwBitRate =
      static_cast<DWORD>(static_cast<long long>(kFrameBytes) * 8 * kFrameRate);
  header->dwBitErrorRate = 0;
  header->AvgTimePerFrame = kFrameDuration100ns;

  header->bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  header->bmiHeader.biWidth = kFrameWidth;
  // NEGATIVE height means top-down rows. DirectShow RGB is bottom-up by default,
  // and the stage is published top-down, so omitting this renders upside down.
  header->bmiHeader.biHeight = -kFrameHeight;
  header->bmiHeader.biPlanes = 1;
  header->bmiHeader.biBitCount = 32;
  header->bmiHeader.biCompression = BI_RGB;
  header->bmiHeader.biSizeImage = kFrameBytes;

  media->majortype = MEDIATYPE_Video;
  media->subtype = MEDIASUBTYPE_RGB32;
  media->bFixedSizeSamples = TRUE;
  media->bTemporalCompression = FALSE;
  media->lSampleSize = kFrameBytes;
  media->formattype = FORMAT_VideoInfo;
}

OutputPin::OutputPin() {
  ::InitializeCriticalSection(&lock_);
  stop_event_ = ::CreateEventW(nullptr, TRUE, FALSE, nullptr);
}

OutputPin::~OutputPin() {
  Stop();
  if (stop_event_) ::CloseHandle(stop_event_);
  if (allocator_) allocator_->Release();
  if (input_) input_->Release();
  if (peer_) peer_->Release();
  if (quality_sink_) quality_sink_->Release();
  ::DeleteCriticalSection(&lock_);
}

HRESULT OutputPin::Create(Filter* owner, OutputPin** out) {
  if (!owner || !out) return E_POINTER;
  *out = nullptr;
  auto* pin = new (std::nothrow) OutputPin();
  if (!pin) return E_OUTOFMEMORY;
  if (!pin->stop_event_) {
    pin->Release();
    return E_OUTOFMEMORY;
  }
  pin->owner_ = owner;
  *out = pin;
  return S_OK;
}

HRESULT OutputPin::QueryInterface(REFIID iid, void** out) {
  if (!out) return E_POINTER;
  if (iid == IID_IUnknown || iid == IID_IPin) {
    *out = static_cast<IPin*>(this);
  } else if (iid == IID_IAMStreamConfig) {
    *out = static_cast<IAMStreamConfig*>(this);
  } else if (iid == IID_IKsPropertySet) {
    *out = static_cast<IKsPropertySet*>(this);
  } else if (iid == IID_IQualityControl) {
    *out = static_cast<IQualityControl*>(this);
  } else {
    *out = nullptr;
    LogGuid("Pin QueryInterface REFUSED", iid, E_NOINTERFACE);
    return E_NOINTERFACE;
  }
  AddRef();
  return S_OK;
}

// The graph asks us to connect to a downstream input pin. A source pin drives
// this: propose our type, then agree on an allocator.
HRESULT OutputPin::Connect(IPin* receive, const AM_MEDIA_TYPE* media) {
  if (!receive) return E_POINTER;
  Lock guard(&lock_);
  if (peer_) return VFW_E_ALREADY_CONNECTED;
  if (owner_ && owner_->IsRunning()) return VFW_E_NOT_STOPPED;

  // A caller-supplied type is honoured only if we can actually produce it.
  AM_MEDIA_TYPE* proposed = nullptr;
  if (media && media->majortype != GUID_NULL) {
    if (!MediaTypeAcceptable(media)) {
      LogLine("Pin::Connect rejected caller media type");
      return VFW_E_TYPE_NOT_ACCEPTED;
    }
  }
  proposed = AllocMediaType();
  if (!proposed) return E_OUTOFMEMORY;

  HRESULT hr = receive->ReceiveConnection(static_cast<IPin*>(this), proposed);
  if (FAILED(hr)) {
    LogLine("Pin::Connect ReceiveConnection hr=0x%08lX", static_cast<unsigned long>(hr));
    FreeMediaTypeContents(proposed);
    ::CoTaskMemFree(proposed);
    return hr;
  }

  IMemInputPin* input = nullptr;
  hr = receive->QueryInterface(IID_IMemInputPin, reinterpret_cast<void**>(&input));
  if (FAILED(hr)) {
    LogLine("Pin::Connect no IMemInputPin hr=0x%08lX", static_cast<unsigned long>(hr));
    receive->Disconnect();
    FreeMediaTypeContents(proposed);
    ::CoTaskMemFree(proposed);
    return VFW_E_NO_TRANSPORT;
  }

  hr = NegotiateAllocator(input);
  if (FAILED(hr)) {
    LogLine("Pin::Connect allocator negotiation hr=0x%08lX",
            static_cast<unsigned long>(hr));
    input->Release();
    receive->Disconnect();
    FreeMediaTypeContents(proposed);
    ::CoTaskMemFree(proposed);
    return hr;
  }

  peer_ = receive;
  peer_->AddRef();
  input_ = input;
  FreeMediaTypeContents(proposed);
  ::CoTaskMemFree(proposed);
  LogLine("Pin::Connect ok  %dx%d RGB32 @%dfps", kFrameWidth, kFrameHeight, kFrameRate);
  return S_OK;
}

// Prefer the consumer's own allocator: some clients require their buffers so they
// can map them without a copy. Only fall back to creating one.
HRESULT OutputPin::NegotiateAllocator(IMemInputPin* input) {
  ALLOCATOR_PROPERTIES request = {};
  request.cBuffers = kBufferCount;
  request.cbBuffer = static_cast<long>(kFrameBytes);
  request.cbAlign = 1;
  request.cbPrefix = 0;

  IMemAllocator* allocator = nullptr;
  HRESULT hr = input->GetAllocator(&allocator);
  bool ours = false;
  if (FAILED(hr) || !allocator) {
    hr = ::CoCreateInstance(CLSID_MemoryAllocator, nullptr, CLSCTX_INPROC_SERVER,
                            IID_IMemAllocator, reinterpret_cast<void**>(&allocator));
    if (FAILED(hr)) return hr;
    ours = true;
  }

  ALLOCATOR_PROPERTIES actual = {};
  hr = allocator->SetProperties(&request, &actual);
  if (FAILED(hr) || actual.cbBuffer < static_cast<long>(kFrameBytes)) {
    // The consumer's allocator refused our size. Fall back to our own rather than
    // streaming into buffers too small for a frame.
    if (!ours) {
      allocator->Release();
      hr = ::CoCreateInstance(CLSID_MemoryAllocator, nullptr, CLSCTX_INPROC_SERVER,
                              IID_IMemAllocator, reinterpret_cast<void**>(&allocator));
      if (FAILED(hr)) return hr;
      ours = true;
      hr = allocator->SetProperties(&request, &actual);
    }
    if (FAILED(hr) || actual.cbBuffer < static_cast<long>(kFrameBytes)) {
      if (allocator) allocator->Release();
      return FAILED(hr) ? hr : E_FAIL;
    }
  }

  hr = input->NotifyAllocator(allocator, FALSE);
  if (FAILED(hr)) {
    allocator->Release();
    return hr;
  }
  if (allocator_) allocator_->Release();
  allocator_ = allocator;
  LogLine("Pin allocator: %ld buffers x %ld bytes (%s)", actual.cBuffers,
          actual.cbBuffer, ours ? "ours" : "consumer's");
  return S_OK;
}

// An output pin is never on the receiving end of a connection.
HRESULT OutputPin::ReceiveConnection(IPin*, const AM_MEDIA_TYPE*) {
  return E_UNEXPECTED;
}

HRESULT OutputPin::Disconnect() {
  Stop();
  Lock guard(&lock_);
  if (owner_ && owner_->IsRunning()) return VFW_E_NOT_STOPPED;
  LogLine("Pin::Disconnect");
  if (allocator_) {
    allocator_->Decommit();
    allocator_->Release();
    allocator_ = nullptr;
  }
  if (input_) {
    input_->Release();
    input_ = nullptr;
  }
  if (peer_) {
    peer_->Release();
    peer_ = nullptr;
  }
  return S_OK;
}

HRESULT OutputPin::ConnectedTo(IPin** pin) {
  if (!pin) return E_POINTER;
  Lock guard(&lock_);
  *pin = peer_;
  if (!*pin) return VFW_E_NOT_CONNECTED;
  (*pin)->AddRef();
  return S_OK;
}

HRESULT OutputPin::ConnectionMediaType(AM_MEDIA_TYPE* media) {
  if (!media) return E_POINTER;
  Lock guard(&lock_);
  if (!peer_) {
    ::ZeroMemory(media, sizeof(AM_MEDIA_TYPE));
    return VFW_E_NOT_CONNECTED;
  }
  auto* header =
      static_cast<VIDEOINFOHEADER*>(::CoTaskMemAlloc(sizeof(VIDEOINFOHEADER)));
  if (!header) return E_OUTOFMEMORY;
  ::ZeroMemory(header, sizeof(VIDEOINFOHEADER));
  ::ZeroMemory(media, sizeof(AM_MEDIA_TYPE));
  BuildMediaType(media, header);
  media->cbFormat = sizeof(VIDEOINFOHEADER);
  media->pbFormat = reinterpret_cast<BYTE*>(header);
  return S_OK;
}

HRESULT OutputPin::QueryPinInfo(PIN_INFO* info) {
  if (!info) return E_POINTER;
  ::ZeroMemory(info, sizeof(PIN_INFO));
  info->dir = PINDIR_OUTPUT;
  ::wcsncpy_s(info->achName, ARRAYSIZE(info->achName), kPinId, _TRUNCATE);
  // Caller releases, per the IPin contract.
  info->pFilter = owner_ ? static_cast<IBaseFilter*>(owner_) : nullptr;
  if (info->pFilter) info->pFilter->AddRef();
  return S_OK;
}

HRESULT OutputPin::QueryDirection(PIN_DIRECTION* direction) {
  if (!direction) return E_POINTER;
  *direction = PINDIR_OUTPUT;
  return S_OK;
}

HRESULT OutputPin::QueryId(LPWSTR* id) {
  if (!id) return E_POINTER;
  const size_t bytes = (::wcslen(kPinId) + 1) * sizeof(wchar_t);
  auto* copy = static_cast<LPWSTR>(::CoTaskMemAlloc(bytes));
  if (!copy) return E_OUTOFMEMORY;
  ::memcpy(copy, kPinId, bytes);
  *id = copy;
  return S_OK;
}

HRESULT OutputPin::QueryAccept(const AM_MEDIA_TYPE* media) {
  return MediaTypeAcceptable(media) ? S_OK : S_FALSE;
}

HRESULT OutputPin::EnumMediaTypes(IEnumMediaTypes** enumerator) {
  if (!enumerator) return E_POINTER;
  auto* created = new (std::nothrow) MediaTypeEnumerator(0);
  if (!created) return E_OUTOFMEMORY;
  *enumerator = created;
  return S_OK;
}

// E_NOTIMPL is the documented way to say "no internal routing", which is correct
// for a source with one pin.
HRESULT OutputPin::QueryInternalConnections(IPin**, ULONG* count) {
  if (count) *count = 0;
  return E_NOTIMPL;
}

// A live camera never ends, flushes, or seeks; these exist to satisfy IPin.
HRESULT OutputPin::EndOfStream() { return S_OK; }

HRESULT OutputPin::BeginFlush() {
  Lock guard(&lock_);
  flushing_ = true;
  return S_OK;
}

HRESULT OutputPin::EndFlush() {
  Lock guard(&lock_);
  flushing_ = false;
  return S_OK;
}

HRESULT OutputPin::NewSegment(REFERENCE_TIME, REFERENCE_TIME, double) { return S_OK; }

HRESULT OutputPin::SetFormat(AM_MEDIA_TYPE* media) {
  // Exactly one format is offered, so this is an accept-or-reject rather than a
  // real setter. Returning S_OK for the format we already produce keeps clients
  // that always call SetFormat working.
  return MediaTypeAcceptable(media) ? S_OK : VFW_E_INVALIDMEDIATYPE;
}

HRESULT OutputPin::GetFormat(AM_MEDIA_TYPE** media) {
  if (!media) return E_POINTER;
  *media = AllocMediaType();
  return *media ? S_OK : E_OUTOFMEMORY;
}

HRESULT OutputPin::GetNumberOfCapabilities(int* count, int* size) {
  if (!count || !size) return E_POINTER;
  *count = 1;
  *size = sizeof(VIDEO_STREAM_CONFIG_CAPS);
  return S_OK;
}

HRESULT OutputPin::GetStreamCaps(int index, AM_MEDIA_TYPE** media, BYTE* caps) {
  if (!media || !caps) return E_POINTER;
  if (index != 0) return S_FALSE;
  *media = AllocMediaType();
  if (!*media) return E_OUTOFMEMORY;

  auto* config = reinterpret_cast<VIDEO_STREAM_CONFIG_CAPS*>(caps);
  ::ZeroMemory(config, sizeof(VIDEO_STREAM_CONFIG_CAPS));
  config->guid = FORMAT_VideoInfo;
  config->VideoStandard = AnalogVideo_None;
  config->InputSize = {kFrameWidth, kFrameHeight};
  config->MinCroppingSize = config->InputSize;
  config->MaxCroppingSize = config->InputSize;
  config->CropGranularityX = 1;
  config->CropGranularityY = 1;
  config->MinOutputSize = config->InputSize;
  config->MaxOutputSize = config->InputSize;
  config->OutputGranularityX = 1;
  config->OutputGranularityY = 1;
  // One fixed rate: advertising a range this source cannot honour invites a
  // consumer to request something it will never receive.
  config->MinFrameInterval = kFrameDuration100ns;
  config->MaxFrameInterval = kFrameDuration100ns;
  config->MinBitsPerSecond =
      static_cast<LONG>(static_cast<long long>(kFrameBytes) * 8 * kFrameRate);
  config->MaxBitsPerSecond = config->MinBitsPerSecond;
  return S_OK;
}

HRESULT OutputPin::Set(REFGUID, DWORD, void*, DWORD, void*, DWORD) {
  return E_NOTIMPL;
}

HRESULT OutputPin::Get(REFGUID set, DWORD id, void*, DWORD, void* data,
                       DWORD data_length, DWORD* returned) {
  if (set != AMPROPSETID_Pin) return E_PROP_SET_UNSUPPORTED;
  if (id != AMPROPERTY_PIN_CATEGORY) return E_PROP_ID_UNSUPPORTED;
  if (returned) *returned = sizeof(GUID);
  // A size query passes a null buffer first.
  if (!data) return S_OK;
  if (data_length < sizeof(GUID)) return E_UNEXPECTED;
  // Without this a client does not treat the pin as a capture pin at all.
  *static_cast<GUID*>(data) = PIN_CATEGORY_CAPTURE;
  return S_OK;
}

HRESULT OutputPin::QuerySupported(REFGUID set, DWORD id, DWORD* support) {
  if (set != AMPROPSETID_Pin) return E_PROP_SET_UNSUPPORTED;
  if (id != AMPROPERTY_PIN_CATEGORY) return E_PROP_ID_UNSUPPORTED;
  if (support) *support = KSPROPERTY_SUPPORT_GET;
  return S_OK;
}

HRESULT OutputPin::Notify(IBaseFilter*, Quality) { return S_OK; }

HRESULT OutputPin::SetSink(IQualityControl* sink) {
  Lock guard(&lock_);
  if (quality_sink_) quality_sink_->Release();
  quality_sink_ = sink;
  if (quality_sink_) quality_sink_->AddRef();
  return S_OK;
}

bool OutputPin::IsConnected() {
  Lock guard(&lock_);
  return peer_ != nullptr;
}

HRESULT OutputPin::Run() {
  Lock guard(&lock_);
  if (!peer_ || !input_ || !allocator_) return VFW_E_NOT_CONNECTED;
  if (thread_) return S_OK;

  HRESULT hr = allocator_->Commit();
  if (FAILED(hr)) {
    LogLine("Pin::Run allocator Commit hr=0x%08lX", static_cast<unsigned long>(hr));
    return hr;
  }
  ::ResetEvent(stop_event_);
  frame_index_ = 0;
  thread_ = ::CreateThread(nullptr, 0, ThreadEntry, this, 0, nullptr);
  if (!thread_) {
    allocator_->Decommit();
    return HRESULT_FROM_WIN32(::GetLastError());
  }
  LogLine("Pin::Run streaming started");
  return S_OK;
}

HRESULT OutputPin::Pause() { return S_OK; }

HRESULT OutputPin::Stop() {
  HANDLE thread = nullptr;
  {
    Lock guard(&lock_);
    thread = thread_;
    thread_ = nullptr;
    if (stop_event_) ::SetEvent(stop_event_);
  }
  // Joined outside the lock: the delivery thread takes the same lock, and waiting
  // for it while holding the lock would deadlock inside a consumer's Stop().
  if (thread) {
    ::WaitForSingleObject(thread, 5000);
    ::CloseHandle(thread);
    LogLine("Pin::Stop streaming stopped");
  }
  Lock guard(&lock_);
  if (allocator_) allocator_->Decommit();
  return S_OK;
}

DWORD WINAPI OutputPin::ThreadEntry(LPVOID context) {
  static_cast<OutputPin*>(context)->DeliverLoop();
  return 0;
}

// Where the caption stage publishes frames. A fixed path, not an environment
// variable: this filter runs inside the CONSUMER process - Teams, Chrome, Slack -
// which knows nothing about our app's environment. The Media Foundation source
// could rely on an env var only because it was activated by our own host.
std::wstring RegionPath() {
  wchar_t program_data[MAX_PATH] = {};
  if (!::GetEnvironmentVariableW(L"ProgramData", program_data, MAX_PATH)) return {};
  std::wstring path(program_data);
  path += L"\\Twinscript\\runtime\\camera-frame-v1.bin";
  return path;
}

// The neutral slate shown when no session is publishing. Deliberately a flat dark
// grey rather than black: black is indistinguishable from a broken camera, and
// telling those two apart without reading a log is worth one shade of grey.
void OutputPin::PaintSlate(BYTE* destination, long capacity) {
  for (long offset = 0; offset + 3 < capacity; offset += 4) {
    destination[offset + 0] = 0x1E;  // B
    destination[offset + 1] = 0x1B;  // G
    destination[offset + 2] = 0x18;  // R
    destination[offset + 3] = 0xFF;
  }
}

bool OutputPin::FillFrame(BYTE* destination, long capacity) {
  // Reopen periodically rather than once: the camera is commonly selected in a
  // meeting client before the app starts publishing, and a filter that gave up on
  // the first miss would stay blank for the rest of the call.
  if (!reader_.IsOpen()) {
    const uint64_t now = vcam::MonotonicNowNs();
    if (now - last_open_attempt_ns_ > 500'000'000ULL) {
      last_open_attempt_ns_ = now;
      const std::wstring path = RegionPath();
      if (!path.empty()) {
        const HRESULT hr = reader_.Open(path.c_str());
        if (FAILED(hr)) {
          // Logged once per attempt window, not per frame: at 15fps a per-frame
          // log would bury everything else in the consumer's log.
          LogLine("region open failed hr=0x%08lX path=%ls",
                  static_cast<unsigned long>(hr), path.c_str());
        } else {
          LogLine("region opened, %zu payload bytes", reader_.PayloadBytes());
        }
      }
    }
    if (!reader_.IsOpen()) {
      PaintSlate(destination, capacity);
      return true;
    }
  }

  const vcam::FrameReadResult result =
      reader_.Read(reinterpret_cast<uint8_t*>(destination),
                   static_cast<size_t>(capacity));
  if (result.status != last_status_) {
    LogLine("region status %u -> %u (sequence=%llu)",
            static_cast<unsigned>(last_status_), static_cast<unsigned>(result.status),
            static_cast<unsigned long long>(result.sequence));
    last_status_ = result.status;
  }

  switch (result.status) {
    case vcam::FrameReadStatus::kFresh:
    case vcam::FrameReadStatus::kRepeat:
      // The reader already wrote the pixels. BGRA8 top-down is byte-identical to
      // the RGB32 negative-height media type this pin advertises, so nothing
      // converts here.
      return true;

    case vcam::FrameReadStatus::kTorn:
      // Lapped mid-copy. Reusing the previous buffer contents is correct: a torn
      // frame is worse than a repeated one.
      return false;

    case vcam::FrameReadStatus::kInvalid:
      // A region whose header no longer validates is not going to recover by
      // itself; drop it and let the reopen path pick up a new one.
      reader_.Close();
      PaintSlate(destination, capacity);
      return true;

    case vcam::FrameReadStatus::kNoFrame:
    case vcam::FrameReadStatus::kExpired:
    case vcam::FrameReadStatus::kIdle:
    case vcam::FrameReadStatus::kStopped:
    default:
      PaintSlate(destination, capacity);
      return true;
  }
}

void OutputPin::DeliverLoop() {
  const REFERENCE_TIME duration = kFrameDuration100ns;

  for (;;) {
    if (::WaitForSingleObject(stop_event_, 0) == WAIT_OBJECT_0) break;

    IMemAllocator* allocator = nullptr;
    IMemInputPin* input = nullptr;
    {
      Lock guard(&lock_);
      if (!allocator_ || !input_) break;
      allocator = allocator_;
      allocator->AddRef();
      input = input_;
      input->AddRef();
    }

    IMediaSample* sample = nullptr;
    HRESULT hr = allocator->GetBuffer(&sample, nullptr, nullptr, 0);
    if (FAILED(hr) || !sample) {
      allocator->Release();
      input->Release();
      if (::WaitForSingleObject(stop_event_, 10) == WAIT_OBJECT_0) break;
      continue;
    }

    BYTE* buffer = nullptr;
    if (SUCCEEDED(sample->GetPointer(&buffer)) && buffer) {
      const long capacity = sample->GetSize();
      const long wanted = static_cast<long>(kFrameBytes);
      const long usable = capacity < wanted ? capacity : wanted;
      FillFrame(buffer, usable);
      sample->SetActualDataLength(usable);
    }

    REFERENCE_TIME start = frame_index_ * duration;
    REFERENCE_TIME stop = start + duration;
    sample->SetTime(&start, &stop);
    sample->SetSyncPoint(TRUE);
    // A live source has no discontinuity except the very first sample.
    sample->SetDiscontinuity(frame_index_ == 0);

    hr = input->Receive(sample);
    if (frame_index_ == 0 || FAILED(hr)) {
      LogLine("Pin deliver frame=%lld hr=0x%08lX", frame_index_,
              static_cast<unsigned long>(hr));
    }
    sample->Release();
    ++frame_index_;

    allocator->Release();
    input->Release();

    if (FAILED(hr)) break;
    // Paced by wall clock rather than the graph clock: a virtual camera has no
    // upstream timing to follow, and 15fps is slow enough that drift is immaterial.
    if (::WaitForSingleObject(stop_event_, 1000 / kFrameRate) == WAIT_OBJECT_0) break;
  }
  LogLine("Pin delivery loop exited after %lld frame(s)", frame_index_);
}

}  // namespace twinscript::dshow
