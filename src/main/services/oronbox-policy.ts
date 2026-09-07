export type BandConnectionReason = 'startup' | 'poll' | 'diagnostics' | 'manual-connect';

export function shouldConnectBand(reason: BandConnectionReason): boolean {
  return reason === 'manual-connect';
}

export type BandConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error';

/** 连接按钮是否可点。已连接、连接中或正在忙时不可点；失败后必须留着重试入口。 */
export function canConnectBand(state: BandConnectionState, busy: boolean): boolean {
  return !busy && state !== 'connected' && state !== 'connecting';
}
