export type SpikeCursor = { id: string; off: number }

declare module 'claude-code' {
  interface PluginState {
    'tcursor-spike': { active: boolean; cursor: SpikeCursor; keysDrawn: string; status: string }
  }
}
