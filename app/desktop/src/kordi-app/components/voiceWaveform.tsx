import { displayVoiceWaveform } from '@/features/chat/useVoiceMessageRecorder';
import { cn } from '@/lib/utils';

export function VoiceWaveform({ samples, progress = 0, live = false }: {
  samples: readonly number[];
  progress?: number;
  live?: boolean;
}) {
  const values = displayVoiceWaveform(samples);
  return (
    <span className="app-voice-waveform" aria-hidden="true">
      {values.map((sample, index) => (
        <span
          key={index}
          className={cn(
            'app-voice-waveform-bar',
            index / values.length <= progress && 'app-voice-waveform-bar-played',
          )}
          style={{ height: `${Math.max(16, Math.min(100, sample * 100))}%` }}
          data-live={live ? 'true' : undefined}
        />
      ))}
    </span>
  );
}

