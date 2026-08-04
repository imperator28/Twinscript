// Minimal COM plumbing shared by the filter, its pin, and the enumerators.
//
// This module implements IBaseFilter and IPin by hand rather than deriving from
// the DirectShow BaseClasses (CSource/CSourceStream). Those classes ship only as
// sample source in the legacy DirectShow SDK, are not in the Windows SDK, and
// would have to be vendored and maintained. The interfaces a capture source needs
// are small enough that hand-rolling them is less code than carrying that
// dependency - the same call OBS made.

#pragma once

#include <windows.h>
#include <new>

namespace twinscript::dshow {

// Keeps DllCanUnloadNow honest. A DLL unloaded while a consumer still holds a
// pin crashes that consumer, and the crash surfaces in the meeting client rather
// than here.
void ModuleObjectCreated();
void ModuleObjectDestroyed();

// Reference-counted base. Derived classes implement QueryInterface only.
//
// Release() deletes through Derived*, so a derived class with a non-public
// destructor must declare `friend class RefCounted<ThatClass>;`. Keeping the
// destructor non-public is worth that one line: these objects are owned solely by
// their reference count, and a caller that deletes one directly corrupts a
// consumer's state rather than ours.
template <typename Derived>
class RefCounted {
 public:
  RefCounted() { ModuleObjectCreated(); }
  RefCounted(const RefCounted&) = delete;
  RefCounted& operator=(const RefCounted&) = delete;

  ULONG STDMETHODCALLTYPE AddRefImpl() { return ::InterlockedIncrement(&ref_count_); }

  ULONG STDMETHODCALLTYPE ReleaseImpl() {
    const ULONG remaining = ::InterlockedDecrement(&ref_count_);
    if (remaining == 0) delete static_cast<Derived*>(this);
    return remaining;
  }

 protected:
  virtual ~RefCounted() { ModuleObjectDestroyed(); }

 private:
  LONG ref_count_ = 1;
};

// Boilerplate for the two IUnknown methods every object here needs. Placed in a
// macro rather than inherited so each class can keep a single vtable and avoid
// ambiguous base resolution when it implements several interfaces.
#define TWINSCRIPT_DSHOW_REFCOUNT(Class)                            \
  ULONG STDMETHODCALLTYPE AddRef() override { return AddRefImpl(); } \
  ULONG STDMETHODCALLTYPE Release() override { return ReleaseImpl(); }

// A scoped critical section. Lock ordering in this module is always
// filter-then-pin; never take them in the other order.
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

}  // namespace twinscript::dshow
