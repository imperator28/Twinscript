const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const fs = require('fs');
const path = require('path');
const {
  resolveMacSigningIdentity,
} = require('./scripts/macos-local-signing.cjs');

const macSigningIdentity = resolveMacSigningIdentity();

// The DirectShow filter is the shipping camera. The Media Foundation source and
// its host are still packaged because the app's install/supervise path has not
// been rewired off them yet - see W6.4 in docs/windows/validation-matrix.md. The MF
// camera enumerates but delivers a black feed in every meeting client, so nothing
// should be built on it.
const WINDOWS_NATIVE_CAMERA_RESOURCES = [
  {
    from: path.join(
      'native',
      'camera-companion',
      'build',
      'Release',
      'twinscript-dshow-camera.dll',
    ),
    name: 'twinscript-dshow-camera.dll',
  },
  {
    from: path.join('scripts', 'register-dshow-camera.ps1'),
    name: 'register-dshow-camera.ps1',
  },
  {
    from: path.join('native', 'camera-companion', 'build', 'Release', 'vcam-host.exe'),
    name: 'vcam-host.exe',
  },
  {
    from: path.join(
      'native',
      'camera-companion',
      'build',
      'Release',
      'twinscript-vcam-source.dll',
    ),
    name: 'twinscript-vcam-source.dll',
  },
  {
    from: path.join('scripts', 'install-native-camera.ps1'),
    name: 'install-native-camera.ps1',
  },
  {
    from: path.join('scripts', 'uninstall-native-camera.ps1'),
    name: 'uninstall-native-camera.ps1',
  },
];

function stageNativeCameraResources(buildPath, platform) {
  if (platform !== 'win32') return;
  const target = path.resolve(buildPath, '..', 'native-camera');
  fs.mkdirSync(target, { recursive: true });
  for (const resource of WINDOWS_NATIVE_CAMERA_RESOURCES) {
    const source = path.resolve(__dirname, resource.from);
    if (!fs.existsSync(source)) {
      throw new Error(
        `Missing Windows native-camera resource: ${resource.from}. ` +
          'Build native/camera-companion Release before packaging.',
      );
    }
    fs.copyFileSync(source, path.join(target, resource.name));
  }
}

// Electron's locale packs only cover Chromium-native UI. This client ships an
// English product UI, so every other pack is pruned.
// Windows/Linux use en-US.pak; macOS uses en.lproj.
const ELECTRON_LANGUAGES = new Set([
  'en', 'en-US',
]);

function pruneElectronLocales(buildPath, platform) {
  const isMac = platform === 'darwin';
  const localesDir = isMac
    ? path.resolve(buildPath, '..')
    : path.resolve(buildPath, '..', '..', 'locales');
  const localeSuffix = isMac ? '.lproj' : '.pak';

  if (!fs.existsSync(localesDir)) return;

  for (const entry of fs.readdirSync(localesDir, { withFileTypes: true })) {
    if (!entry.name.endsWith(localeSuffix)) continue;
    const language = entry.name.slice(0, -localeSuffix.length);
    if (!ELECTRON_LANGUAGES.has(language)) {
      fs.rmSync(path.join(localesDir, entry.name), { recursive: true, force: true });
    }
  }
}

module.exports = {
  packagerConfig: {
    asar: true,
    extraResource: [
      'assets',
      'resources',
      // Local inference is a selectable production pipeline. Packaging must
      // fail if its verified runtime was not staged; silently omitting it would
      // produce a Settings option that can never start.
      ...(process.platform === 'win32' ? ['artifacts/local-inference-host'] : []),
    ],
    icon: process.platform === 'win32' ? 'assets/icon.ico' : 'assets/icon',
    appBundleId: 'com.jiyu.twinscript',
    // Prefer the stable self-signed local identity created by
    // `npm run macos:signing:setup`. It keeps the Keychain caller identity
    // consistent across local rebuilds without Apple Developer membership.
    // CI and new machines retain an explicit ad-hoc fallback.
    osxSign: {
      identity: macSigningIdentity,
      identityValidation: false,
      continueOnError: false,
      // @electron/osx-sign applies hardened runtime in its per-file defaults;
      // disable it for local ad-hoc signing or dyld rejects the Electron
      // framework because neither side has a Developer ID team.
      optionsForFile: () => ({
        hardenedRuntime: false,
        timestamp: false,
      }),
    },
    extendInfo: {
      CFBundleDisplayName: 'Twinscript',
      LSApplicationCategoryType: 'public.app-category.utilities',
      NSMicrophoneUsageDescription:
        'Twinscript uses your microphone to transcribe your side of the meeting.',
      NSScreenCaptureUsageDescription:
        'Twinscript captures meeting audio so both audiences can follow the conversation.',
    },
    executableName: 'twinscript',
    name: 'Twinscript',
    // Whitelist-based ignore: only include package.json, dist-electron/,
    // build/ (minus wasm/), and node_modules/ (pruned by Forge).
    // Everything else (src/, public/, model-packs/, etc.) is excluded.
    ignore: (filePath) => {
      // Root is always included
      if (filePath === '') return false;

      // Source maps are useful in local build output but not at runtime.
      if (filePath.endsWith('.map')) return true;

      // Allow runtime-essential top-level entries
      if (filePath === '/package.json') return false;
      if (filePath.startsWith('/dist-electron')) return false;
      if (filePath.startsWith('/node_modules')) {
        // Strip dev-only junk inside node_modules
        if (/\/((@testing-library|jest|eslint|babel)[^/]*|@parcel\/watcher)(\/|$)/.test(filePath)) return true;
        if (/\.(ts|flow|markdown)$/.test(filePath)) return true;
        return false;
      }
      if (filePath.startsWith('/build')) {
        // WASM runtime dirs are INCLUDED (workers need importScripts / wasmPaths):
        //   sherpa-onnx-asr, sherpa-onnx-asr-stream, sherpa-onnx-tts, ort, vad, piper-plus
        // Model data dirs are EXCLUDED (downloaded at runtime via CDN + IndexedDB):
        //   sherpa-onnx-asr-sensevoice, opus-mt-*, sherpa-onnx-tts-piper-*, etc.
        if (filePath.startsWith('/build/wasm')) {
          // Must include the /build/wasm directory itself so its children are traversed
          if (filePath === '/build/wasm') return false;
          // This caption client transcribes through OpenAI WebSockets; the only
          // WASM it loads is GTCRN noise suppression on the microphone path
          // (src/lib/modern-audio/gtcrn/gtcrn-worker.ts), which needs the GTCRN
          // model plus the ONNX Runtime it runs on. The upstream local-inference
          // runtimes (sherpa-onnx ASR/TTS, piper-plus, vad-web — ~37 MB) are not
          // reachable from src/App.tsx and no built artifact references their
          // paths, so they are excluded from the Windows package.
          const wasmRuntimeDirs = [
            '/build/wasm/ort',
            '/build/wasm/gtcrn',
          ];
          // Keep runtime dirs and their contents, exclude everything else
          if (wasmRuntimeDirs.some(dir => filePath === dir || filePath.startsWith(dir + '/'))) return false;
          return true;
        }
        // Exclude debug assets
        if (filePath.startsWith('/build/assets/test-tone') && filePath.endsWith('.mp3')) return true;
        return false;
      }

      // Reject everything else
      return true;
    },
    // Only include necessary files
    prune: true,
    // Reduce executable size by removing debug symbols
    derefSymlinks: true,
    // Overwrite files if they already exist
    overwrite: true
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'Twinscript',
        authors: 'Jiyu Qian',
        exe: 'twinscript.exe',
        description: 'Private realtime English and Chinese meeting captions',
        setupIcon: 'assets/icon.ico',
        // Add/Remove Programs fetches this over HTTP, unauthenticated. It must
        // resolve in this repository, not the upstream Sokuji one.
        //
        // Two reasons it does not resolve yet, neither fixable here:
        //   - the repository is private, so raw.githubusercontent.com returns 404
        //     to the anonymous fetch Windows makes;
        //   - `main` still holds the fork's icon, since the replacement landed on
        //     a feature branch.
        // Both clear on their own - going public, and merging - and until then the
        // installed-programs list shows a generic icon rather than a wrong one.
        iconUrl:
          'https://raw.githubusercontent.com/imperator28/Twinscript/main/assets/icon.ico',
        noMsi: true
      }
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        name: 'Twinscript',
        overwrite: true
      }
    }
    // PKG Installer removed - use npm run make:pkg for unsigned PKG builds
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      // This local-file meeting client does not store authentication cookies.
      // Enabling Chromium cookie encryption makes macOS query Keychain before
      // the first window is created. API credentials remain encrypted through
      // Electron safeStorage in CredentialStore.
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  // Add hooks to further optimize the build
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform) => {
      pruneElectronLocales(buildPath, platform);
      stageNativeCameraResources(buildPath, platform);
    },
    packageAfterPrune: async (forgeConfig, buildPath) => {
      // List of directories to check and remove unnecessary files
      const dirsToClean = [
        path.join(buildPath, 'node_modules')
      ];
      
      // Extensions and patterns of files to remove
      const patternsToRemove = [
        '.md', '.markdown', '.ts', '.map', '.flow', '.jst', 
        'LICENSE', 'license', 'LICENCE', 'licence',
        'CONTRIBUTING', 'HISTORY', 'CHANGELOG', 
        '.travis.yml', '.github', '.eslintrc', '.editorconfig',
        'Makefile', '.npmignore', '.gitignore', '.gitattributes',
        'example', 'examples', 'test', 'tests', '__tests__', 
        'coverage', '.nyc_output', '.vscode', '.idea'
      ];
      
      console.info('Cleaning unnecessary files from node_modules...');
      
      // Function to recursively remove unnecessary files
      const cleanDir = (dirPath) => {
        if (!fs.existsSync(dirPath)) return;
        
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          
          if (entry.isDirectory()) {
            // Skip essential directories
            if (entry.name === 'node_modules' || entry.name === 'bin') {
              cleanDir(fullPath);
              continue;
            }
            
            // Check if directory name matches patterns to remove
            if (patternsToRemove.some(pattern => 
              entry.name === pattern || 
              entry.name.endsWith(pattern)
            )) {
              try {
                fs.rmSync(fullPath, { recursive: true, force: true });
                console.debug(`Removed directory: ${fullPath}`);
              } catch (err) {
                console.error(`Error removing ${fullPath}:`, err);
              }
            } else {
              cleanDir(fullPath);
            }
          } else if (entry.isFile()) {
            // Check if file matches patterns to remove
            if (patternsToRemove.some(pattern => 
              entry.name === pattern || 
              entry.name.endsWith(pattern)
            )) {
              try {
                fs.unlinkSync(fullPath);
                console.debug(`Removed file: ${fullPath}`);
              } catch (err) {
                console.error(`Error removing ${fullPath}:`, err);
              }
            }
          }
        }
      };
      
      // Clean each directory
      for (const dir of dirsToClean) {
        cleanDir(dir);
      }
      
      // Remove src/ directories from node_modules packages, but only when
      // the package's "main" entry does NOT reference src/ (some packages
      // like "debug" use src/ for runtime code)
      const nmDir = path.join(buildPath, 'node_modules');
      const removeSrcDirs = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('@')) {
            // Scoped package — recurse one level deeper
            removeSrcDirs(fullPath);
            continue;
          }
          const srcDir = path.join(fullPath, 'src');
          if (!fs.existsSync(srcDir)) continue;
          // Check if this package's main entry references src/
          try {
            const pkgJson = JSON.parse(fs.readFileSync(path.join(fullPath, 'package.json'), 'utf8'));
            const main = pkgJson.main || 'index.js';
            if (!main.includes('src/') && !main.includes('src\\')) {
              fs.rmSync(srcDir, { recursive: true, force: true });
              console.debug(`Removed src/ from: ${entry.name}`);
            }
          } catch {
            // No package.json — skip
          }
        }
      };
      removeSrcDirs(nmDir);

      console.info('Finished cleaning unnecessary files.');
    }
  }
};
