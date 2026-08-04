#pragma once

#include <windows.h>

namespace twinscript::dshow {

// Write or remove both halves of the registration: the COM in-proc server and
// the video-input-device category entry. `root` selects HKLM or HKCU.
//
// HKLM is what a real install needs. HKCU works for a developer loop only, and
// only for consumers running as the same user.
HRESULT RegisterFilterServer(HMODULE module, HKEY root, bool add);

}  // namespace twinscript::dshow
