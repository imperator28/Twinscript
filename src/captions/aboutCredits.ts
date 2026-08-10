/**
 * Attribution shown in Settings.
 *
 * These strings are data rather than JSX so they can be checked. Two of the
 * claims here are the kind that quietly rot:
 *
 * - **The version.** A credits card showing the wrong version is worse than one
 *   showing none, because a bug report will quote it. `aboutCredits.test.ts`
 *   reads `package.json` and fails if `APP_VERSION` has drifted.
 *
 * - **The stack.** Crediting a library the app no longer loads is a false
 *   statement about what is running. The same test asserts every named package
 *   is still a declared dependency.
 *
 * `onnxruntime-web` was originally left out of this list on the grounds that no
 * caption path reached it. That was wrong. `ModernAudioRecorder` spawns
 * `src/lib/modern-audio/gtcrn/gtcrn-worker.ts` for noise suppression on the
 * microphone, and that worker imports ONNX Runtime through the shim under
 * `src/lib/local-inference/workers/_shared/`. forge.config.js says the same thing
 * from the packaging side: `ort` and `gtcrn` are the only two WASM directories
 * that ship. It runs on every session, so it is credited.
 *
 * The rest of `src/lib/local-inference` - the sherpa-onnx ASR, piper TTS and
 * translation engines - is retained in the repository but genuinely unreachable
 * from the app, and is not credited.
 *
 * Also deliberately not credited as a source: OBS. Its virtual camera was used
 * only as a consumer to validate ours against, and it is GPL-2.0 - none of its
 * code is in this app. The "Virtual camera" line says so explicitly, because
 * "DirectShow virtual camera on Windows" invites exactly that assumption.
 */

export const APP_NAME = 'Twinscript';
export const APP_NAME_ZH = '会意';
export const APP_VERSION = '0.1.0';
export const APP_LICENSE = 'AGPL-3.0';
export const APP_LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';

/** Upstream foundation, per docs/architecture/sokuji-reuse-map.md. */
export const UPSTREAM_NAME = 'Sokuji';
export const UPSTREAM_VERSION = 'v0.34.5';

export interface Credit {
  /** Short label. Rendered as the `dt` of a two-column list, not as prose. */
  label: string;
  body: string;
}

export const CREDITS: readonly Credit[] = [
  {
    label: 'Runs on',
    body: 'Electron, React, Vite and TypeScript.',
  },
  {
    label: 'Captions by',
    body: "OpenAI's realtime models over a WebSocket opened with ws, or local Whisper and Hy-MT2 through the native inference host, according to your selected pipeline.",
  },
  {
    label: 'Audio cleanup',
    body: 'GTCRN noise suppression on the microphone, running on ONNX Runtime Web.',
  },
  {
    label: 'Icons by',
    body: 'Lucide.',
  },
  {
    label: 'Forked from',
    body: `${UPSTREAM_NAME} ${UPSTREAM_VERSION}, whose audio capture and window handling this app keeps.`,
  },
  {
    label: 'Virtual camera',
    body: 'An independent DirectShow filter written for this app, not derived from any existing virtual camera.',
  },
];

/** Packages named above, as they appear in package.json. */
export const CREDITED_PACKAGES: readonly string[] = [
  'electron',
  'react',
  'vite',
  'typescript',
  'ws',
  'lucide-react',
  'onnxruntime-web',
];

export const SIGNATURE = 'Designed by Jiyu';
