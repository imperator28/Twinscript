#pragma once

#include <windows.h>

#include <string>

namespace twinscript::vcam {

inline std::wstring CameraFrameRegionPath() {
  wchar_t override_path[32768] = {};
  const DWORD override_length = ::GetEnvironmentVariableW(
      L"TWINSCRIPT_VCAM_REGION_PATH", override_path, ARRAYSIZE(override_path));
  if (override_length > 0 && override_length < ARRAYSIZE(override_path)) {
    return override_path;
  }

  wchar_t program_data[MAX_PATH] = {};
  const DWORD length =
      ::GetEnvironmentVariableW(L"ProgramData", program_data, ARRAYSIZE(program_data));
  std::wstring path =
      length > 0 && length < ARRAYSIZE(program_data) ? program_data : L"C:\\ProgramData";
  path += L"\\Twinscript\\runtime\\camera-frame-v1.bin";
  return path;
}

inline bool SyntheticFramesRequested() {
  wchar_t value[8] = {};
  const DWORD length = ::GetEnvironmentVariableW(
      L"TWINSCRIPT_VCAM_SYNTHETIC", value, ARRAYSIZE(value));
  return length > 0 && length < ARRAYSIZE(value) && value[0] == L'1';
}

}  // namespace twinscript::vcam
