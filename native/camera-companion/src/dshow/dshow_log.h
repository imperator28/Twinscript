// Logging seam for the DirectShow virtual camera.
//
// The filter is loaded into whatever process opens the camera - Teams, Chrome,
// the Camera app - none of which give us a console. A log file is the only way to
// observe what a consumer asked for.
//
// Deliberately a separate file from the Media Foundation source's log: during the
// transition both may be installed, and interleaving two cameras' traces into one
// file made the MF investigation harder than it needed to be.

#pragma once

#include <windows.h>

namespace twinscript::dshow {

void LogLine(const char* format, ...);

// Spell a GUID out so it can be looked up. Used for media subtypes, property
// sets, and refused interfaces - the three things worth knowing when a consumer
// walks away.
inline void LogGuid(const char* what, REFGUID guid, HRESULT hr) {
  LogLine("%s {%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X} hr=0x%08lX", what,
          guid.Data1, guid.Data2, guid.Data3, guid.Data4[0], guid.Data4[1],
          guid.Data4[2], guid.Data4[3], guid.Data4[4], guid.Data4[5], guid.Data4[6],
          guid.Data4[7], static_cast<unsigned long>(hr));
}

}  // namespace twinscript::dshow
