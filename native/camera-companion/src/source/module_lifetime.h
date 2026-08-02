#pragma once

namespace bilingual::vcam {

// Every COM object implemented by the in-process server participates in this
// count. COM may ask DllCanUnloadNow while activation/source/stream objects are
// still live, so reference counts alone are not sufficient protection.
void ModuleObjectCreated();
void ModuleObjectDestroyed();

}  // namespace bilingual::vcam
