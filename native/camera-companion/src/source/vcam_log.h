// Shared logging seam for the media source.
//
// The frame server hosts this DLL inside a service process with no console, so a
// log file is the only way to observe what Windows asked for. Defined in
// dll_main.cpp so every translation unit writes to the same file.

#pragma once

#include <windows.h>

namespace twinscript::vcam {

void LogLine(const char* format, ...);

// Record a QueryInterface we refused, with the IID spelled out so it can be
// looked up.
inline void LogUnsupportedInterface(const char* who, REFIID iid) {
  LogLine("%s QueryInterface REFUSED {%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}", who,
          iid.Data1, iid.Data2, iid.Data3, iid.Data4[0], iid.Data4[1], iid.Data4[2],
          iid.Data4[3], iid.Data4[4], iid.Data4[5], iid.Data4[6], iid.Data4[7]);
}

// Record any GUID-carrying call with its result. Used for the calls that succeed
// as well as the ones that fail: knowing the LAST call the Frame Server makes
// before abandoning a source is the diagnosis, and a log of refusals alone cannot
// distinguish "gave up immediately" from "gave up after several good calls".
inline void LogGuidLine(const char* what, REFGUID guid, HRESULT hr) {
  LogLine("%s {%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X} hr=0x%08lX", what,
          guid.Data1, guid.Data2, guid.Data3, guid.Data4[0], guid.Data4[1], guid.Data4[2],
          guid.Data4[3], guid.Data4[4], guid.Data4[5], guid.Data4[6], guid.Data4[7],
          static_cast<unsigned long>(hr));
}

}  // namespace twinscript::vcam
