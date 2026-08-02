// Stable identifiers for the virtual camera.
//
// The CLSID is the `sourceId` handed to MFCreateVirtualCamera and the key the
// COM registration is written under. It must never change once a build has
// shipped: a different CLSID leaves the previously registered camera orphaned.

#pragma once

#include <guiddef.h>

namespace bilingual::vcam {

// {6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03}
// clang-format off
constexpr GUID kMediaSourceClsid = {
    0x6b8f2c4a, 0x9d3e, 0x4a17, {0x8c, 0x25, 0x1e, 0x7b, 0x4f, 0x6d, 0x9a, 0x03}};
// clang-format on

constexpr wchar_t kMediaSourceClsidString[] = L"{6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03}";

// What the user picks in Teams, Zoom, or Chrome. Windows decorates it on
// enumeration as "<name> (Windows Virtual Camera)", so consumers must match on
// this as a prefix rather than comparing the whole string.
constexpr wchar_t kCameraFriendlyName[] = L"Bilingual Meeting Captions";

constexpr wchar_t kComRegistryDescription[] = L"Bilingual Meeting Captions Camera Source";

}  // namespace bilingual::vcam
