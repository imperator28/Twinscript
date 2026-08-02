# W4 blank feed — ETW trace and reference diff, 2026-08-02

**Outcome: unresolved.** The native camera enumerates, activates, and is
inspected, then the pipeline goes silent. `MediaSource::Start` and
`MediaStream::RequestSample` are never called; a consumer's `ReadSample` fails
with `MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED` (`0xC00D3EA2`).

**OBS Virtual Camera works end-to-end into meeting apps.** The product has a
functioning camera path today; W4 removes the OBS dependency, it does not
unlock a capability.

## Method

Process Monitor was **not** the right tool and was not used. ETW had already
shown the DLL loads and the CLSID resolves, so file/registry tracing would have
added nothing. Used instead:

1. **ETW** — six Media Foundation providers including
   `Microsoft-Windows-MF-FrameServer`, 17,964 events decoded.
2. **Registry IID lookup** — free, and should have preceded any tracer.
3. **Reference diff** — Microsoft's `Samples/VirtualCamera` from
   [microsoft/Windows-Camera](https://github.com/microsoft/Windows-Camera).

## An invalidated intermediate conclusion

An earlier note claimed "Start is never called". That rested on an installed
DLL built *before* the logging was merged — it could not have logged those calls
either way. After rebuilding and reinstalling with logging present, the claim
held: zero matches for `MediaSource::Start`, `MediaStream::Start`,
`RequestSample`, or `DeliverSample`. Only then was it evidence.

## What the ETW trace established

- The Frame Server reports **no error at all**. Exactly two failing HRESULTs in
  17,964 events, both `0xC00D3EA2` from `MFReadWrite` — the source reader
  telling *our consumer* the device died. Nothing rejects us.
- Frames flow at 15 fps (`Duration=666666` hns) with `hr=0x0` and stats
  `Input=8320 Output=8319 Dropped=0`. These are **not ours** — our source is
  never asked for a frame. Most likely the Integrated Camera. Unresolved.
- Our camera is named 33 times, all enumeration, all in the first 776 events.
  Nothing references it again when a consumer attaches.
- **Signing is disproven.** An unsigned-module rejection happens before
  `DllGetClassObject`; ours succeeds every time.

## The unidentified interface

Immediately after `ActivateObject` succeeds, Windows queries three interfaces
and we refuse all three, after which the pipeline goes quiet:

| IID | Identity |
| --- | --- |
| `{2032C7EF-76F6-492A-94F3-4A81F69380CC}` | **Unknown.** Absent from the Windows SDK, from `HKLM\Classes\Interface`, from WOW6432Node, and from the Microsoft reference sample. A private interface with no marshalling registration. |
| `{5BC8A76B-…}` | `IMFCollection` — documented, optional |
| `{B91EBFEE-…}` | `IMFExtendedCameraController` — documented, optional |

It cannot be resolved by lookup. Identifying it needs a debugger on the caller.

## Reference diff: gaps found

| Gap | Status |
| --- | --- |
| `MF_DEVICESTREAM_FRAMESERVER_SHARED = 1` on stream attributes | **Implemented.** Did not fix the feed. |
| `MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES` on the stream (we set it only on the source) | **Implemented.** Did not fix the feed. |
| `IMFSampleAllocatorControl` on the media source | **Not implemented.** The reference declares it: `winrt::implements<SimpleMediaSource, IMFMediaSourceEx, IMFGetService, IKsControl, IMFSampleAllocatorControl>`. Note Windows never asks us for its IID (`{DA62B958-…}`), so this may be latent rather than causal. |
| `MF_DEVICEMFT_SENSORPROFILE_COLLECTION` | **Not implemented.** The reference publishes a sensor profile collection. |
| `MF_VIRTUALCAMERA_CONFIGURATION_APP_PACKAGE_FAMILY_NAME` | Not implemented. Reference sets a PFN; may imply the frame server expects a packaged configuration app. |

## Why this stopped here

Four plausible causes have now been tested and eliminated — refused interfaces,
file ACLs, NV12 vs RGB32, `AddDeviceSourceInfo` — plus the two attributes above.
Each iteration costs a rebuild, an elevated reinstall, and a UAC prompt, and the
sequence is not converging. Guessing at attribute number seven against an
undocumented contract is not a strategy.

The control experiment that would settle *whether the fault is our code or this
machine* — building and running Microsoft's reference camera here — was not
completed: the sample needs NuGet, C++/WinRT projections and MSBuild, and
`vswhere` did not resolve an MSBuild instance on this machine.

## To resume

In priority order:

1. **Build and run the Microsoft reference sample.** If it streams here, the
   fault is ours and the remaining gaps above are the search space. If it fails
   identically, the fault is environmental and no change to our source helps.
   Needs an MSBuild instance and NuGet restore.
2. **WinDbg plus Microsoft public symbols.** Break on our `QueryInterface` for
   `{2032C7EF-…}` and read the caller's stack. This names the component and the
   code path that abandons us — the only direct route to the undocumented
   contract. Neither the debugger nor symbols is installed.
3. Implement `IMFSampleAllocatorControl` and the sensor profile collection —
   cheap, correct per the reference, but speculative as a fix.

Do not resume before W3's 60-minute soak passes. OBS already delivers this
capability end-to-end, and W1, W2 and W3 remain unpassed on real hardware.
