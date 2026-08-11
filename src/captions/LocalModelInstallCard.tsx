import type { LocalModelId, LocalModelPhase, LocalModelState, LocalModelStatus } from './types';

export type LocalModelAction = 'install' | 'verify' | 'repair' | 'remove';

export interface LocalModelInstallCardProps {
  /** The narrow renderer snapshot. A missing snapshot is safely presented as unavailable. */
  status: LocalModelStatus | null;
  /** The model currently changing, if the owner has an action in flight. */
  busyModel?: LocalModelId | null;
  onAction: (modelId: LocalModelId, action: LocalModelAction) => void;
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

const deviceText = (model: LocalModelState) => {
  if (model.actualDevice) return `Running on ${model.actualDevice}`;
  if (model.expectedDevice) return `${model.expectedDevice} when available`;
  return 'Device selected when the model starts';
};

const actionsFor = (model: LocalModelState, catalogAvailable: boolean): LocalModelAction[] => {
  switch (model.phase) {
    case 'not-installed':
      return catalogAvailable ? ['install'] : [];
    case 'ready':
      return ['verify', 'remove'];
    case 'repair-needed':
      return ['repair', 'remove'];
    case 'failed':
      return ['repair'];
    default:
      return [];
  }
};

export function LocalModelInstallCard({ status, busyModel = null, onAction }: LocalModelInstallCardProps) {
  const catalogAvailable = status?.catalog.available ?? false;
  const readyCount = modelIds.filter((id) => status?.models[id].ready).length;
  const meetingLocked = status?.actionLocks.meetingActive ?? false;
  const catalogMessage = status?.catalog.error?.message ?? (status ? null : 'Checking whether local models are available.');

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
      {meetingLocked && (
        <p id="local-models-meeting-lock" className="local-model-card__lock" role="status">
          Model changes are locked while a meeting is active. End the meeting before installing, verifying, repairing, or removing models.
        </p>
      )}

      <div className="local-model-card__models">
        {modelIds.map((id) => {
          const model = status?.models[id] ?? unavailableModel(id);
          const displayName = model.displayName || modelCopy[id].displayName;
          const purpose = model.purpose || modelCopy[id].purpose;
          const total = formatBytes(model.downloadBytes);
          const downloaded = formatBytes(model.downloadedBytes);
          const progress = model.downloadBytes && model.downloadedBytes !== undefined
            ? Math.min(100, Math.round((model.downloadedBytes / model.downloadBytes) * 100))
            : null;
          const actions = actionsFor(model, catalogAvailable);

          return (
            <section className={`local-model-row is-${model.phase}`} key={id} aria-labelledby={`${id}-heading`}>
              <div className="local-model-row__summary">
                <div>
                  <h3 id={`${id}-heading`}>{displayName}</h3>
                  <p>{purpose}</p>
                </div>
                <span className="local-model-row__state">{phaseLabel[model.phase]}</span>
              </div>

              <p className="local-model-row__metadata">
                <span>{model.version ? `Version ${model.version}` : 'Version not available'}</span>
                {total && <><i aria-hidden="true">·</i><span>{total} download</span></>}
                <i aria-hidden="true">·</i><span>{deviceText(model)}</span>
              </p>

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

              {model.phase === 'failed' && (
                <p className="local-model-row__error" role="alert">
                  {model.error?.message ?? 'The model could not be prepared. Repair the model to try again.'}
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
                        aria-describedby={meetingLocked ? 'local-models-meeting-lock' : undefined}
                        onClick={() => onAction(id, action)}
                      >
                        {action[0].toUpperCase() + action.slice(1)} {displayName}
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
