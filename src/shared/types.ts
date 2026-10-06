// ── Domain types ──
// A building telemetry pipeline deals in three things: readings that arrive,
// anomalies derived from them, and commands issued in response.

/** Kinds of device we simulate. Both are common in commercial building stock. */
export type DeviceKind = 'hvac' | 'electricity_meter'

export interface Device {
  deviceId: string
  kind: DeviceKind
  buildingId: string
  floor: number
  /** Expected operating band. Readings outside it are candidate anomalies. */
  normalRange: { min: number; max: number }
  unit: 'celsius' | 'kwh'
}

export interface Reading {
  deviceId: string
  buildingId: string
  kind: DeviceKind
  value: number
  unit: string
  /** Epoch milliseconds. Device clock, not ingest clock — they differ in the field. */
  timestamp: number
}

export type AnomalyType = 'threshold_breach' | 'sensor_drift' | 'device_silent'

export interface Anomaly {
  deviceId: string
  buildingId: string
  type: AnomalyType
  severity: 'warning' | 'critical'
  detail: string
  /** The readings that justified this call, for audit. */
  evidence: Reading[]
  detectedAt: number
}

export interface Command {
  deviceId: string
  buildingId: string
  action: 'setpoint_adjust' | 'flag_for_inspection' | 'notify_operator'
  reason: string
  issuedAt: number
}

export const TOPICS = {
  readings: 'telemetry.readings',
  anomalies: 'telemetry.anomalies',
  commands: 'telemetry.commands',
} as const
