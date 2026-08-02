// Shared logging seam for the media source.
//
// The frame server hosts this DLL inside a service process with no console, so a
// log file is the only way to observe what Windows asked for. Defined in
// dll_main.cpp so every translation unit writes to the same file.

#pragma once

#include <windows.h>

namespace bilingual::vcam {

void LogLine(const char* format, ...);

// Record a QueryInterface we refused, with the IID spelled out so it can be
// looked up.
inline void LogUnsupportedInterface(const char* who, REFIID iid) {
  LogLine("%s QueryInterface REFUSED {%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}", who,
          iid.Data1, iid.Data2, iid.Data3, iid.Data4[0], iid.Data4[1], iid.Data4[2],
          iid.Data4[3], iid.Data4[4], iid.Data4[5], iid.Data4[6], iid.Data4[7]);
}

}  // namespace bilingual::vcam
