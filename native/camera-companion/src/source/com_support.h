// Minimal COM helpers.
//
// Deliberately hand-rolled rather than pulling in ATL or C++/WinRT: the
// companion must build from a bare "Desktop development with C++" install with
// no extra components, because the Windows developer-setup doc only requires
// MSVC + the Windows SDK.

#pragma once

#include <windows.h>
#include <unknwn.h>

#include <utility>

namespace twinscript::vcam {

// Owning smart pointer for COM interfaces.
template <typename T>
class ComPtr {
 public:
  ComPtr() = default;
  ComPtr(std::nullptr_t) {}

  ComPtr(T* raw) : ptr_(raw) {
    if (ptr_) ptr_->AddRef();
  }

  ComPtr(const ComPtr& other) : ComPtr(other.ptr_) {}

  ComPtr(ComPtr&& other) noexcept : ptr_(other.ptr_) { other.ptr_ = nullptr; }

  ~ComPtr() { Reset(); }

  ComPtr& operator=(const ComPtr& other) {
    if (this != &other) {
      Reset();
      ptr_ = other.ptr_;
      if (ptr_) ptr_->AddRef();
    }
    return *this;
  }

  ComPtr& operator=(ComPtr&& other) noexcept {
    if (this != &other) {
      Reset();
      ptr_ = other.ptr_;
      other.ptr_ = nullptr;
    }
    return *this;
  }

  void Reset() {
    if (ptr_) {
      ptr_->Release();
      ptr_ = nullptr;
    }
  }

  // For out-parameters: `Fn(ptr.GetAddressOf())`. Releases any current value
  // first so a reused ComPtr cannot leak.
  T** GetAddressOf() {
    Reset();
    return &ptr_;
  }

  // For in-out cases where the callee does not overwrite on failure.
  T** AddressOfUnchecked() { return &ptr_; }

  T* Get() const { return ptr_; }
  T* operator->() const { return ptr_; }
  explicit operator bool() const { return ptr_ != nullptr; }

  // Hand ownership to a caller's out-parameter.
  T* Detach() {
    T* raw = ptr_;
    ptr_ = nullptr;
    return raw;
  }

  void Attach(T* raw) {
    Reset();
    ptr_ = raw;
  }

  template <typename U>
  HRESULT As(ComPtr<U>* out) const {
    if (!ptr_) return E_POINTER;
    return ptr_->QueryInterface(__uuidof(U), reinterpret_cast<void**>(out->GetAddressOf()));
  }

 private:
  T* ptr_ = nullptr;
};

// RAII critical-section lock. The media source is called from arbitrary Media
// Foundation worker threads, so every state transition is serialized.
class Lock {
 public:
  explicit Lock(CRITICAL_SECTION* section) : section_(section) {
    ::EnterCriticalSection(section_);
  }
  ~Lock() { ::LeaveCriticalSection(section_); }
  Lock(const Lock&) = delete;
  Lock& operator=(const Lock&) = delete;

 private:
  CRITICAL_SECTION* section_;
};

// Standard QueryInterface tail: hand back `this` as `Base` for `iid`.
template <typename Base, typename Self>
bool TryInterface(Self* self, REFIID iid, void** out) {
  if (iid == __uuidof(Base)) {
    Base* casted = static_cast<Base*>(self);
    casted->AddRef();
    *out = casted;
    return true;
  }
  return false;
}

}  // namespace twinscript::vcam
