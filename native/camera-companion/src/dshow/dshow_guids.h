// Stable identifiers for the DirectShow virtual camera.
//
// WHY DIRECTSHOW AND NOT MEDIA FOUNDATION
//
// The Media Foundation virtual camera (MFCreateVirtualCamera + IMFMediaSource)
// enumerates in every meeting client and streams perfectly to an in-process
// consumer, but produces a black feed in Teams, and five attempts failed to
// change that. Differential tracing against Microsoft's own reference camera
// showed our source makes the identical call sequence, exposes the identical
// interfaces, and is still not served. It also showed why that path cannot be
// debugged further: in BOTH the working and failing cases the observable instance
// is only used for capability inspection, and the instance that actually delivers
// frames lives somewhere neither log can reach.
//
// DirectShow has no such opacity, and more importantly it is proven on the target
// hardware: OBS Virtual Camera is a DirectShow capture filter, it is registered
// exactly this way, and it works in Teams on the same machine where the MF camera
// is black.
//
// This is a clean-room implementation informed by that architecture. OBS is
// GPL-2.0; none of its code is copied here.

#pragma once

#include <guiddef.h>

namespace twinscript::dshow {

// {1F5A7C2E-8D64-4B93-9E11-3A6C5D8F27B4}
// Deliberately different from the Media Foundation source's CLSID: both can be
// registered at once during the transition, and a previously installed MF camera
// is not silently repurposed. Must never change once a build has shipped.
// clang-format off
constexpr GUID kFilterClsid = {
    0x1f5a7c2e, 0x8d64, 0x4b93, {0x9e, 0x11, 0x3a, 0x6c, 0x5d, 0x8f, 0x27, 0xb4}};
// clang-format on

constexpr wchar_t kFilterClsidString[] = L"{1F5A7C2E-8D64-4B93-9E11-3A6C5D8F27B4}";

// What the user picks in Teams, Zoom, or Chrome. Unlike the Media Foundation
// path, Windows does NOT decorate a DirectShow filter's name, so this is the
// exact string a consumer sees and an exact match is correct.
constexpr wchar_t kFilterName[] = L"Twinscript";

// The stage is produced at 1080p15 and published as BGRA. DirectShow's
// MEDIASUBTYPE_RGB32 is byte-identical to BGRA8, so no conversion sits between
// the renderer and the consumer.
constexpr int kFrameWidth = 1920;
constexpr int kFrameHeight = 1080;
constexpr int kFrameRate = 15;

// 100-nanosecond units per frame, the unit DirectShow timestamps use.
constexpr long long kFrameDuration100ns = 10'000'000LL / kFrameRate;

}  // namespace twinscript::dshow
