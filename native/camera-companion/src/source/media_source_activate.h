// The activation object Windows actually asks the registered CLSID for.
//
// Discovered empirically: MFCreateVirtualCamera does not CoCreateInstance the
// registered CLSID as an IMFMediaSource. It asks for IMFActivate
// ({7FEE9E9A-4A89-47A6-899C-B6A53A70FB67}) and later calls ActivateObject() to
// obtain the source. Returning E_NOINTERFACE for IMFActivate surfaces from
// IMFVirtualCamera::Start as a bare E_NOINTERFACE with no other diagnostic, so
// the class factory must hand back this object, not a MediaSource.
//
// IMFActivate derives from IMFAttributes, and Windows stores virtual-camera
// configuration on it, so the whole attribute surface is delegated to a real
// store created by MFCreateAttributes rather than stubbed out.

#pragma once

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>

#include "com_support.h"
#include "media_source.h"
#include "module_lifetime.h"

namespace bilingual::vcam {

class MediaSourceActivate : public IMFActivate {
 public:
  static HRESULT CreateInstance(MediaSourceActivate** out);

  // -- IUnknown
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override;
  ULONG STDMETHODCALLTYPE AddRef() override { return ::InterlockedIncrement(&ref_count_); }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = ::InterlockedDecrement(&ref_count_);
    if (remaining == 0) delete this;
    return remaining;
  }

  // -- IMFActivate
  HRESULT STDMETHODCALLTYPE ActivateObject(REFIID iid, void** out) override;
  HRESULT STDMETHODCALLTYPE ShutdownObject() override;
  HRESULT STDMETHODCALLTYPE DetachObject() override;

  // -- IMFAttributes: delegated in full to the inner store.
  HRESULT STDMETHODCALLTYPE GetItem(REFGUID key, PROPVARIANT* value) override {
    return attributes_->GetItem(key, value);
  }
  HRESULT STDMETHODCALLTYPE GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE* type) override {
    return attributes_->GetItemType(key, type);
  }
  HRESULT STDMETHODCALLTYPE CompareItem(REFGUID key, REFPROPVARIANT value,
                                       BOOL* result) override {
    return attributes_->CompareItem(key, value, result);
  }
  HRESULT STDMETHODCALLTYPE Compare(IMFAttributes* other, MF_ATTRIBUTES_MATCH_TYPE type,
                                   BOOL* result) override {
    return attributes_->Compare(other, type, result);
  }
  HRESULT STDMETHODCALLTYPE GetUINT32(REFGUID key, UINT32* value) override {
    return attributes_->GetUINT32(key, value);
  }
  HRESULT STDMETHODCALLTYPE GetUINT64(REFGUID key, UINT64* value) override {
    return attributes_->GetUINT64(key, value);
  }
  HRESULT STDMETHODCALLTYPE GetDouble(REFGUID key, double* value) override {
    return attributes_->GetDouble(key, value);
  }
  HRESULT STDMETHODCALLTYPE GetGUID(REFGUID key, GUID* value) override {
    return attributes_->GetGUID(key, value);
  }
  HRESULT STDMETHODCALLTYPE GetStringLength(REFGUID key, UINT32* length) override {
    return attributes_->GetStringLength(key, length);
  }
  HRESULT STDMETHODCALLTYPE GetString(REFGUID key, LPWSTR value, UINT32 size,
                                     UINT32* length) override {
    return attributes_->GetString(key, value, size, length);
  }
  HRESULT STDMETHODCALLTYPE GetAllocatedString(REFGUID key, LPWSTR* value,
                                              UINT32* length) override {
    return attributes_->GetAllocatedString(key, value, length);
  }
  HRESULT STDMETHODCALLTYPE GetBlobSize(REFGUID key, UINT32* size) override {
    return attributes_->GetBlobSize(key, size);
  }
  HRESULT STDMETHODCALLTYPE GetBlob(REFGUID key, UINT8* buffer, UINT32 size,
                                   UINT32* written) override {
    return attributes_->GetBlob(key, buffer, size, written);
  }
  HRESULT STDMETHODCALLTYPE GetAllocatedBlob(REFGUID key, UINT8** buffer,
                                            UINT32* size) override {
    return attributes_->GetAllocatedBlob(key, buffer, size);
  }
  HRESULT STDMETHODCALLTYPE GetUnknown(REFGUID key, REFIID iid, LPVOID* out) override {
    return attributes_->GetUnknown(key, iid, out);
  }
  HRESULT STDMETHODCALLTYPE SetItem(REFGUID key, REFPROPVARIANT value) override {
    return attributes_->SetItem(key, value);
  }
  HRESULT STDMETHODCALLTYPE DeleteItem(REFGUID key) override {
    return attributes_->DeleteItem(key);
  }
  HRESULT STDMETHODCALLTYPE DeleteAllItems() override { return attributes_->DeleteAllItems(); }
  HRESULT STDMETHODCALLTYPE SetUINT32(REFGUID key, UINT32 value) override {
    return attributes_->SetUINT32(key, value);
  }
  HRESULT STDMETHODCALLTYPE SetUINT64(REFGUID key, UINT64 value) override {
    return attributes_->SetUINT64(key, value);
  }
  HRESULT STDMETHODCALLTYPE SetDouble(REFGUID key, double value) override {
    return attributes_->SetDouble(key, value);
  }
  HRESULT STDMETHODCALLTYPE SetGUID(REFGUID key, REFGUID value) override {
    return attributes_->SetGUID(key, value);
  }
  HRESULT STDMETHODCALLTYPE SetString(REFGUID key, LPCWSTR value) override {
    return attributes_->SetString(key, value);
  }
  HRESULT STDMETHODCALLTYPE SetBlob(REFGUID key, const UINT8* buffer, UINT32 size) override {
    return attributes_->SetBlob(key, buffer, size);
  }
  HRESULT STDMETHODCALLTYPE SetUnknown(REFGUID key, IUnknown* value) override {
    return attributes_->SetUnknown(key, value);
  }
  HRESULT STDMETHODCALLTYPE LockStore() override { return attributes_->LockStore(); }
  HRESULT STDMETHODCALLTYPE UnlockStore() override { return attributes_->UnlockStore(); }
  HRESULT STDMETHODCALLTYPE GetCount(UINT32* count) override {
    return attributes_->GetCount(count);
  }
  HRESULT STDMETHODCALLTYPE GetItemByIndex(UINT32 index, GUID* key,
                                          PROPVARIANT* value) override {
    return attributes_->GetItemByIndex(index, key, value);
  }
  HRESULT STDMETHODCALLTYPE CopyAllItems(IMFAttributes* destination) override {
    return attributes_->CopyAllItems(destination);
  }

 private:
  MediaSourceActivate() {
    ModuleObjectCreated();
    ::InitializeCriticalSection(&lock_);
  }
  ~MediaSourceActivate() {
    ::DeleteCriticalSection(&lock_);
    ModuleObjectDestroyed();
  }

  LONG ref_count_ = 1;
  CRITICAL_SECTION lock_{};
  ComPtr<IMFAttributes> attributes_;
  ComPtr<MediaSource> source_;
};

}  // namespace bilingual::vcam
