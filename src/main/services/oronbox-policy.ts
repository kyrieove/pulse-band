export type BandConnectionReason = 'startup' | 'poll' | 'diagnostics' | 'manual-connect';

export function shouldConnectBand(reason: BandConnectionReason): boolean {
  return reason === 'manual-connect';
}
