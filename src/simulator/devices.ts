import type { Device } from '../shared/types.js'

// Two buildings, mixed plant. Small enough to read in a terminal, varied enough
// that the detectors have something to distinguish.
export const DEVICES: Device[] = [
  { deviceId: 'hvac-a-01', kind: 'hvac', buildingId: 'bldg-a', floor: 1, normalRange: { min: 20, max: 26 }, unit: 'celsius' },
  { deviceId: 'hvac-a-02', kind: 'hvac', buildingId: 'bldg-a', floor: 2, normalRange: { min: 20, max: 26 }, unit: 'celsius' },
  { deviceId: 'hvac-a-03', kind: 'hvac', buildingId: 'bldg-a', floor: 3, normalRange: { min: 20, max: 26 }, unit: 'celsius' },
  { deviceId: 'meter-a-01', kind: 'electricity_meter', buildingId: 'bldg-a', floor: 0, normalRange: { min: 30, max: 90 }, unit: 'kwh' },
  { deviceId: 'meter-a-02', kind: 'electricity_meter', buildingId: 'bldg-a', floor: 0, normalRange: { min: 30, max: 90 }, unit: 'kwh' },
  { deviceId: 'hvac-b-01', kind: 'hvac', buildingId: 'bldg-b', floor: 1, normalRange: { min: 20, max: 26 }, unit: 'celsius' },
  { deviceId: 'hvac-b-02', kind: 'hvac', buildingId: 'bldg-b', floor: 2, normalRange: { min: 20, max: 26 }, unit: 'celsius' },
  { deviceId: 'meter-b-01', kind: 'electricity_meter', buildingId: 'bldg-b', floor: 0, normalRange: { min: 30, max: 90 }, unit: 'kwh' },
]

/**
 * Faults are assigned deliberately, not randomly, so a demo run always shows
 * all three detectors firing. Everything else behaves normally — a pipeline
 * where every device is broken proves nothing.
 */
export const FAULTS: Record<string, 'spike' | 'drift' | 'silence'> = {
  'hvac-a-02': 'spike',    // overshoots its band in bursts
  'meter-a-02': 'drift',   // slowly loses calibration
  'hvac-b-02': 'silence',  // stops reporting partway through
}
