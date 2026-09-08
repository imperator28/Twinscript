import type { RefObject } from 'react';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  CloudOff,
  Download,
  Wrench,
} from 'lucide-react';
import type { LocalModelId, LocalModelPhase, LocalModelState, LocalModelStatus } from './types';
import { missingLocalModels } from './localModelSetup';

export type LocalModelAction = 'install' | 'verify' | 'repair' | 'remove' | 'adopt';

export interface LocalModelInstallCardProps {
  /** The narrow renderer snapshot. A missing snapshot is safely presented as unavailable. */
  status: LocalModelStatus | null;
  /** The model currently changing, if the owner has an action in flight. */
  busyModel?: LocalModelId | null;
  rowRefs?: Partial<Record<LocalModelId, RefObject<HTMLElement | null>>>;
  onAction: (action: LocalModelAction, modelId: LocalModelId) => void;
  requiredModels?: LocalModelId[];
  onInstallMissing?: () => void;
  onRuntimeAction?: (action: 'install' | 'verify' | 'remove' | 'cancel', id: string) => void;
}

const modelCopy: Record<LocalModelId, Pick<LocalModelState, 'displayName' | 'purpose' | 'expectedDevice'>> = {
  'whisper-small': {
    displayName: 'Whisper Small',
    purpose: 'Speech recognition',
    expectedDevice: 'NPU',
  },
  'hy-mt2-1.8b': {
    displayName: 'HY-MT2 1.8B',
    purpose: 'English and Chinese translation',
    expectedDevice: 'GPU',
  },
};

const modelIds: LocalModelId[] = ['whisper-small', 'hy-mt2-1.8b'];

const phaseLabel: Record<LocalModelPhase, string> = {
  unavailable: 'Unavailable',
  'not-installed': 'Not installed',
  downloading: 'Downloading',
  verifying: 'Verifying files',
  ready: 'Ready',
  'repair-needed': 'Repair needed',
  failed: 'Failed',
};

const formatBytes = (bytes: number | undefined) => {
  if (!bytes || bytes < 0) return null;
  const megabytes = bytes / 1_000_000;
  return megabytes >= 1_000 ? `${(megabytes / 1_000).toFixed(1)} GB` : `${Math.round(megabytes)} MB`;
};

const unavailableModel = (id: LocalModelId): LocalModelState => ({
  id,
  version: null,
  ...modelCopy[id],
  downloadBytes: undefined,
  installedBytes: undefined,
  downloadedBytes: undefined,
  installed: false,
  verified: false,
  phase: 'unavailable',
  ready: false,
  repairRecommended: false,
  error: null,
  actualDevice: null,
});

const mutationIsLocked = (status: LocalModelStatus, action: LocalModelAction) =>
  status.actionLocks.meetingActive || status.actionLocks[action === 'install' ? 'download' : action];

export interface HyMt2DeviceStatus {
  label: string;
  detail: string | null;
}

const cudaFallbackDetail: Record<string, string> = {
  local_translation_host_closed:
    'The NVIDIA translation process stopped unexpectedly, so Twinscript continued locally on the CPU.',
  local_translation_device_unverified:
    'The NVIDIA translation runtime could not be verified, so Twinscript continued locally on the CPU.',
  local_translation_start_timeout:
    'The NVIDIA translation runtime took too long to start, so Twinscript continued locally on the CPU.',
  local_translation_spawn_failed:
    'The NVIDIA translation runtime could not start, so Twinscript continued locally on the CPU.',
  local_translation_health_failed:
    'The NVIDIA translation runtime did not become ready, so Twinscript continued locally on the CPU.',
  local_translation_restart_exhausted:
    'The NVIDIA translation runtime stopped repeatedly, so Twinscript continued locally on the CPU.',
  cuda_model_allocation_failed:
    'The NVIDIA runtime could not allocate the translation model, so Twinscript continued locally on the CPU.',
};

export const formatHyMt2DeviceStatus = (model: LocalModelState): HyMt2DeviceStatus => {
  if (model.actualDevice === 'CUDA0') {
    return {
      label: model.offload === 'partial' ? 'NVIDIA GPU · partial offload' : 'NVIDIA GPU',
      detail: null,
    };
  }
  if (model.actualDevice === 'CPU' && model.fallbackReason && model.fallbackReason !== 'cuda_device_unavailable') {
    return {
      label: 'CPU fallback',
      detail: cudaFallbackDetail[model.fallbackReason]
        ?? 'NVIDIA acceleration was unavailable, so Twinscript continued locally on the CPU.',
    };
  }
  if (model.actualDevice === 'CPU') return { label: 'CPU', detail: null };
  return {
    label: 'Uses NVIDIA GPU when available; CPU fallback included',
    detail: null,
  };
};

const whisperDeviceText = (model: LocalModelState) => {
  if (model.actualDevice) return `Last ran on ${model.actualDevice}`;
  return 'Designed for Intel NPU';
};

const stateIcon = (phase: LocalModelPhase) => {
  const iconProps = { size: 14, strokeWidth: 2.4, 'aria-hidden': true as const };
  switch (phase) {
    case 'ready': return <CircleCheck {...iconProps} />;
    case 'downloading': return <Download {...iconProps} />;
    case 'verifying': return <CircleDashed {...iconProps} />;
    case 'repair-needed': return <Wrench {...iconProps} />;
    case 'failed': return <CircleX {...iconProps} />;
    case 'unavailable': return <CloudOff {...iconProps} />;
    default: return <CircleAlert {...iconProps} />;
  }
};

const actionLabel = (action: LocalModelAction, id: LocalModelId) =>
  action === 'adopt'
    ? `Use local ${id === 'whisper-small' ? 'Whisper local transcription model' : 'HY-MT2 local translation model'} files`
    : `${action[0].toUpperCase() + action.slice(1)} ${id === 'whisper-small' ? 'Whisper local transcription model' : 'HY-MT2 local translation model'}`;

const actionsFor = (model: LocalModelState, catalogAvailable: boolean, localAdoptionAvailable: boolean): LocalModelAction[] => {
  switch (model.phase) {
    case 'not-installed':
      return catalogAvailable ? [localAdoptionAvailable ? 'adopt' : 'install'] : [];
    case 'ready':
      return ['verify', 'remove'];
    case 'repair-needed':
      return [localAdoptionAvailable ? 'adopt' : 'repair', 'remove'];
    case 'failed':
      return ['repair'];
    default:
      return [];
  }
};

export function LocalModelInstallCard({ status, busyModel = null, rowRefs, onAction, requiredModels = [], onInstallMissing, onRuntimeAction }: LocalModelInstallCardProps) {
  const catalogAvailable = status?.catalog.available ?? false;
  const localAdoptionAvailable = status?.catalog.localAdoptionAvailable === true;
  const readyCount = modelIds.filter((id) => status?.models[id].ready).length;
  const meetingLocked = status?.actionLocks.meetingActive ?? false;
  const catalogMessage = status?.catalog.error?.message ?? (status ? null : 'Checking whether local models are available.');
  const missing = missingLocalModels(requiredModels, status);
  const runtimeBundles = Object.values(status?.runtime.bundles || {});
  const runtimeMissing = Boolean(status?.runtime.bundles?.['openvino-cpu'] && !status.runtime.ready && !status.runtime.bundles['openvino-cpu'].ready);
  const runtimeBusy = runtimeBundles.some(bundle => !['ready', 'not-installed', 'failed'].includes(bundle.phase));
  const unsupported = status?.runtime.supported === false;
  const setupBusy = runtimeBusy || busyModel !== null || requiredModels.some((id) => ['downloading', 'verifying'].includes(status?.models[id]?.phase ?? ''));

  return (
    <article className="card local-model-card" aria-labelledby="local-models-heading">
      <p className="eyebrow">LOCAL AI MODELS</p>
      <div className="section-heading">
        <div>
          <h2 id="local-models-heading">Private, on-device processing</h2>
          <p className="supporting-copy">
            Downloaded speech and translation models run on this device. Your meeting audio is not sent to a model provider for these steps.
          </p>
        </div>
        <span className="local-model-card__aggregate" aria-label={`${readyCount} of 2 models ready`}>
          {readyCount} of 2 ready
        </span>
      </div>

      {catalogMessage && (
        <p className="local-model-card__catalog" role={status?.catalog.error ? 'status' : undefined}>
          {catalogMessage}
        </p>
      )}
      {onInstallMissing && requiredModels.length > 0 && (
        <div className="local-model-card__setup">
          <p>{runtimeMissing ? 'Your selected pipeline needs the local processing engine. Existing models are kept.' : missing.length === 0
            ? 'The models for your selected pipeline are installed.'
            : `Your selected pipeline needs ${missing.map((id) => modelCopy[id].displayName).join(' and ')}. Installed models are kept.`}</p>
          {(missing.length > 0 || runtimeMissing) && (
            <button type="button" className="button button--primary"
              disabled={unsupported || setupBusy || !status || mutationIsLocked(status, 'install') || localAdoptionAvailable}
              onClick={onInstallMissing}>
              {setupBusy ? 'Setting up models…' : runtimeMissing ? 'Set up local processing' : `Install missing ${missing.length === 1 ? 'model' : 'models'}`}
            </button>
          )}
          {localAdoptionAvailable && missing.length > 0 && <p>This build supports local files only. A download-enabled release is required for automatic setup.</p>}
        </div>
      )}
      {meetingLocked && (
        <p id="local-models-meeting-lock" className="local-model-card__lock" role="status">
          Model changes are locked while a meeting is active. End the meeting before installing, verifying, repairing, or removing models.
        </p>
      )}

      <div className="local-model-card__models">
        {unsupported && <p role="status">Local processing is not supported on this platform yet. Choose cloud models to start a session.</p>}
        {!unsupported && runtimeBundles.filter(bundle => bundle.id !== 'cuda' || status?.runtime.cudaAvailable || bundle.ready).map(bundle => {
          const title = bundle.id === 'cuda' ? 'NVIDIA acceleration (optional)' : 'Local processing engine';
          const active = !['ready', 'not-installed', 'failed'].includes(bundle.phase);
          return <section className="local-model-row" key={bundle.id} aria-label={title}>
            <div className="local-model-row__summary"><div><h3>{title}</h3><p>{bundle.id === 'cuda' ? 'Translation acceleration; CPU fallback remains available.' : 'Required for local models. CPU processing and Intel NPU support.'}</p></div>
              <span className="local-model-row__state">{bundle.ready ? 'Ready' : bundle.phase.split('-').join(' ')}</span></div>
            {active && <progress aria-label={`${title} download`} max={bundle.totalBytes || 1} value={bundle.downloadedBytes || 0} />}
            {bundle.error && <p role="alert">{bundle.error.message} Please retry, or check your connection and download availability.</p>}
            <div className="local-model-row__actions">
              {active ? <button className="button button--secondary" onClick={() => onRuntimeAction?.('cancel', bundle.id)}>Cancel download</button> : <>
                <button className="button button--secondary" disabled={meetingLocked || setupBusy || !onRuntimeAction}
                  onClick={() => onRuntimeAction?.(bundle.ready ? 'verify' : 'install', bundle.id)}>{bundle.ready ? 'Verify engine' : bundle.phase === 'failed' ? 'Retry download' : 'Install engine'}</button>
                {bundle.ready && <button className="button button--secondary" disabled={meetingLocked || setupBusy || !onRuntimeAction}
                  onClick={() => onRuntimeAction?.('remove', bundle.id)}>Remove engine</button>}
              </>}
            </div>
          </section>;
        })}
        {modelIds.map((id) => {
          const model = status?.models[id] ?? unavailableModel(id);
          const displayName = model.displayName || modelCopy[id].displayName;
          const purpose = model.purpose || modelCopy[id].purpose;
          const total = formatBytes(model.downloadBytes);
          const downloaded = formatBytes(model.downloadedBytes);
          const progress = model.downloadBytes && model.downloadedBytes !== undefined
            ? Math.min(100, Math.round((model.downloadedBytes / model.downloadBytes) * 100))
            : null;
          const actions = actionsFor(model, catalogAvailable, localAdoptionAvailable);
          const translationDevice = id === 'hy-mt2-1.8b' ? formatHyMt2DeviceStatus(model) : null;

          return (
            <section
              className={`local-model-row is-${model.phase}`}
              key={id}
              ref={rowRefs?.[id]}
              tabIndex={-1}
              aria-labelledby={`${id}-heading`}
            >
              <div className="local-model-row__summary">
                <div>
                  <h3 id={`${id}-heading`}>{displayName}</h3>
                  <p>{purpose}</p>
                </div>
                <span className="local-model-row__state">
                  {stateIcon(model.phase)}
                  <span>{phaseLabel[model.phase]}</span>
                </span>
              </div>

              <div className="local-model-row__metadata">
                <span>{model.version ? `Version ${model.version}` : 'Version not available'}</span>
                {total && <><i aria-hidden="true">·</i><span>{total} download</span></>}
                <i aria-hidden="true">·</i>
                <span>{translationDevice?.label ?? whisperDeviceText(model)}</span>
              </div>

              {translationDevice?.detail && (
                <details className="local-model-row__runtime-detail">
                  <summary>Why Twinscript is using the CPU</summary>
                  <p>{translationDevice.detail}</p>
                </details>
              )}

              {model.phase === 'downloading' && progress !== null && (
                <div className="local-model-row__progress-wrap">
                  <progress
                    className="local-model-row__progress"
                    value={progress}
                    max={100}
                    aria-label={`Downloading ${displayName}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                    aria-valuetext={downloaded && total ? `${downloaded} of ${total} downloaded` : `${progress}% downloaded`}
                  />
                  <p>{downloaded && total ? `${downloaded} of ${total} downloaded` : `${progress}% downloaded`}</p>
                </div>
              )}

              {(model.phase === 'failed' || model.phase === 'repair-needed') && model.error && (
                <p className="local-model-row__error" role="alert">
                  {model.error.message}
                </p>
              )}

              {actions.length > 0 && (
                <div className="local-model-row__actions">
                  {actions.map((action) => {
                    const locked = status ? mutationIsLocked(status, action) : true;
                    const disabled = locked || busyModel !== null;
                    return (
                      <button
                        className={`button ${action === 'install' || action === 'repair' ? 'button--primary' : 'button--quiet'}`}
                        key={action}
                        type="button"
                        disabled={disabled}
                        aria-label={actionLabel(action, id)}
                        aria-describedby={meetingLocked ? 'local-models-meeting-lock' : undefined}
                        onClick={() => onAction(action, id)}
                      >
                        {action === 'adopt' ? 'Use local files' : action[0].toUpperCase() + action.slice(1)}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </article>
  );
}
