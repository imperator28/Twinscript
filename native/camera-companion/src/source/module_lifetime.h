#pragma once

namespace twinscript::vcam {

// Every COM object implemented by the in-process server participates in this
// count. COM may ask DllCanUnloadNow while activation/source/stream objects are
// still live, so reference counts alone are not sufficient protection.
void ModuleObjectCreated();
void ModuleObjectDestroyed();

}  // namespace twinscript::vcam
