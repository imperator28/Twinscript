import { createRef } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { formatHyMt2DeviceStatus, LocalModelInstallCard } from './LocalModelInstallCard';
import type { LocalModelId, LocalModelPhase, LocalModelStatus } from './types';

const model = (
  id: LocalModelId,
  phase: LocalModelPhase,
  overrides: Partial<LocalModelStatus['models'][LocalModelId]> = {},
): LocalModelStatus['models'][LocalModelId] => ({
  id,
  version: id === 'whisper-small' ? 'v3.1' : 'v1.2',
  displayName: id === 'whisper-small' ? 'Whisper Small' : 'HY-MT2 1.8B',
  purpose: id === 'whisper-small' ? 'Speech recognition' : 'English and Chinese translation',
  expectedDevice: id === 'whisper-small' ? 'NPU' : 'GPU',
  downloadBytes: id === 'whisper-small' ? 512_000_000 : 1_800_000_000,
  installedBytes: phase === 'ready' ? 512_000_000 : 0,
  downloadedBytes: phase === 'downloading' ? 256_000_000 : 0,
  installed: phase === 'ready',
  verified: phase === 'ready',
  phase,
  ready: phase === 'ready',
  repairRecommended: phase === 'repair-needed',
  error: phase === 'failed' ? { code: 'CHECKSUM', message: 'The model files could not be verified.' } : null,
  actualDevice: phase === 'ready' ? 'NPU' : null,
  ...overrides,
});

const status = (overrides: Partial<LocalModelStatus> = {}): LocalModelStatus => ({
  catalog: { available: true, error: null },
  runtime: { ready: false, requestedDevice: 'NPU' },
  models: {
    'whisper-small': model('whisper-small', 'not-installed'),
    'hy-mt2-1.8b': model('hy-mt2-1.8b', 'not-installed'),
  },
  actionLocks: { meetingActive: false, download: false, verify: false, repair: false, remove: false },
  ...overrides,
});

describe('LocalModelInstallCard', () => {
  it.each([
    [{ actualDevice: 'CUDA0', offload: 'full' }, 'NVIDIA GPU'],
    [{ actualDevice: 'CUDA0', offload: 'partial' }, 'NVIDIA GPU · partial offload'],
    [{ actualDevice: 'CPU', fallbackReason: 'local_translation_host_closed' }, 'CPU fallback'],
    [{ actualDevice: 'CPU', fallbackReason: 'cuda_device_unavailable' }, 'CPU'],
    [{ actualDevice: 'CPU', fallbackReason: null }, 'CPU'],
    [{ actualDevice: null, fallbackReason: null }, 'Uses NVIDIA GPU when available; CPU fallback included'],
  ] as const)('formats HY-MT2 device evidence as %s', (runtime, label) => {
    expect(formatHyMt2DeviceStatus(model('hy-mt2-1.8b', 'ready', runtime)).label).toBe(label);
  });

  it('shows a keyboard-accessible friendly CPU fallback explanation without raw codes', () => {
    render(<LocalModelInstallCard status={status({ models: {
      'whisper-small': model('whisper-small', 'ready'),
      'hy-mt2-1.8b': model('hy-mt2-1.8b', 'ready', {
        actualDevice: 'CPU', requestedDevice: 'CUDA_AUTO', offload: 'none',
        fallbackReason: 'local_translation_host_closed',
      }),
    } })} onAction={vi.fn()} />);

    const row = screen.getByRole('region', { name: 'HY-MT2 1.8B' });
    expect(within(row).getByText('CPU fallback')).toBeVisible();
    fireEvent.click(within(row).getByText('Why Twinscript is using the CPU'));
    expect(within(row).getByText(/NVIDIA translation process stopped unexpectedly/i)).toBeVisible();
    expect(row).not.toHaveTextContent('local_translation_host_closed');
    expect(row).not.toHaveTextContent('CUDA0');
  });

  it('renders the private local-model card with independent model detail rows', () => {
    const whisperRef = createRef<HTMLElement>();
    render(
      <LocalModelInstallCard
        status={status()}
        rowRefs={{ 'whisper-small': whisperRef }}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText('LOCAL AI MODELS')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Private, on-device processing' })).toBeVisible();
    expect(screen.getByText('0 of 2 ready')).toBeVisible();
    expect(screen.getByText('Whisper Small')).toBeVisible();
    expect(screen.getByText('HY-MT2 1.8B')).toBeVisible();
    expect(screen.getAllByText('Not installed')).toHaveLength(2);
    expect(screen.getByText('Speech recognition')).toBeVisible();
    expect(screen.getByText('English and Chinese translation')).toBeVisible();
    expect(screen.getByText('Version v3.1')).toBeVisible();
    expect(screen.getByText(/512 MB download/i)).toBeVisible();
    expect(screen.getByText('Designed for Intel NPU')).toBeVisible();
    expect(screen.getByText('Uses NVIDIA GPU when available; CPU fallback included')).toBeVisible();
    expect(whisperRef.current).toHaveAttribute('tabindex', '-1');
  });

  it('uses context-specific install, verify, repair, and remove actions', () => {
    const onAction = vi.fn();
    const current = status({
      models: {
        'whisper-small': model('whisper-small', 'ready'),
        'hy-mt2-1.8b': model('hy-mt2-1.8b', 'repair-needed'),
      },
    });
    render(<LocalModelInstallCard status={current} onAction={onAction} />);

    fireEvent.click(screen.getByRole('button', { name: 'Verify Whisper local transcription model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Whisper local transcription model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Repair HY-MT2 local translation model' }));

    expect(onAction).toHaveBeenNthCalledWith(1, 'verify', 'whisper-small');
    expect(onAction).toHaveBeenNthCalledWith(2, 'remove', 'whisper-small');
    expect(onAction).toHaveBeenNthCalledWith(3, 'repair', 'hy-mt2-1.8b');
    expect(screen.getByRole('button', { name: 'Verify Whisper local transcription model' })).toHaveTextContent(/^Verify$/);
    expect(screen.getByRole('button', { name: 'Remove Whisper local transcription model' })).toHaveTextContent(/^Remove$/);
  });

  it('offers Use local files instead of download for a local-only development catalog', () => {
    const onAction = vi.fn();
    render(
      <LocalModelInstallCard
        status={status({
          catalog: { available: true, localAdoptionAvailable: true, error: null },
          actionLocks: { meetingActive: false, download: true, verify: false, repair: false, remove: false, adopt: false },
        })}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use local Whisper local transcription model files' }));
    expect(onAction).toHaveBeenCalledWith('adopt', 'whisper-small');
    expect(screen.queryByRole('button', { name: 'Install Whisper local transcription model' })).not.toBeInTheDocument();
  });

  it('announces downloading progress natively without treating it as an error', () => {
    render(
      <LocalModelInstallCard
        status={status({
          models: {
            'whisper-small': model('whisper-small', 'downloading'),
            'hy-mt2-1.8b': model('hy-mt2-1.8b', 'verifying'),
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByRole('progressbar', { name: 'Downloading Whisper Small' })).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText(/256 MB of 512 MB downloaded/i)).toBeVisible();
    expect(screen.getByText('Verifying files')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders failed and repair-needed model errors as alerts with recovery actions', () => {
    render(
      <LocalModelInstallCard
        status={status({
          models: {
            'whisper-small': model('whisper-small', 'failed'),
            'hy-mt2-1.8b': model('hy-mt2-1.8b', 'repair-needed', {
              error: { code: 'STALE', message: 'The translation model needs repair.' },
            }),
          },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('The model files could not be verified.');
    expect(screen.getByText('The translation model needs repair.')).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: 'Repair Whisper local transcription model' })).toBeEnabled();
  });

  it.each<LocalModelPhase>(['unavailable', 'not-installed', 'downloading', 'verifying', 'ready', 'repair-needed', 'failed'])(
    'gives the %s phase a visible text status',
    (phase) => {
      render(
        <LocalModelInstallCard
          status={status({
            models: {
              'whisper-small': model('whisper-small', phase),
              'hy-mt2-1.8b': model('hy-mt2-1.8b', 'ready'),
            },
          })}
          onAction={vi.fn()}
        />,
      );

      expect(
        within(screen.getByRole('region', { name: 'Whisper Small' })).getByText(
          new RegExp(phase.replace('-', ' '), 'i'),
        ),
      ).toBeVisible();
    },
  );

  it('handles an unavailable catalog and disables mutations while a meeting is active', () => {
    const { rerender } = render(
      <LocalModelInstallCard
        status={status({
          catalog: { available: false, error: { code: 'CATALOG_OFFLINE', message: 'Model catalog is unavailable.' } },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText('Model catalog is unavailable.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Install Whisper local transcription model' })).not.toBeInTheDocument();

    rerender(
      <LocalModelInstallCard
        status={status({
          actionLocks: { meetingActive: true, download: false, verify: false, repair: false, remove: false },
        })}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByText(/Model changes are locked while a meeting is active/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Install Whisper local transcription model' })).toBeDisabled();
  });
});
