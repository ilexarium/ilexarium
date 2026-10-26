import type { SystemSample } from '@laris/shared';
import { CPU_HWMON_CHIPS, CPU_THERMAL_ZONES, TEMPERATURE_RANGE_C } from './host.constants.js';
import type { TemperatureSensor } from './host.model.js';

export type CpuTemperature = NonNullable<SystemSample['temperature']>;

/** A sysfs temperature (millidegrees Celsius); null when unreadable or out of range. */
export function parseMilliCelsius(text: string | null): number | null {
  if (text === null) return null;
  const value = Number(text.trim());
  if (!text.trim() || !Number.isFinite(value)) return null;
  const celsius = value / 1000;
  return celsius >= TEMPERATURE_RANGE_C.min && celsius <= TEMPERATURE_RANGE_C.max
    ? Math.round(celsius * 10) / 10
    : null;
}

/** The processor's sensor: the best hwmon chip first, then the best thermal zone. */
export function pickCpuSensor(
  hwmon: TemperatureSensor[],
  zones: TemperatureSensor[],
): TemperatureSensor | null {
  for (const [chip, labels] of CPU_HWMON_CHIPS) {
    const inputs = hwmon.filter((sensor) => sensor.chip === chip);
    if (inputs.length === 0) continue;
    const preferred = labels
      .map((label) => inputs.find((sensor) => sensor.label === label))
      .find((sensor) => sensor !== undefined);
    return preferred ?? hottest(inputs);
  }
  for (const pattern of CPU_THERMAL_ZONES) {
    const matching = zones.filter((zone) => pattern.test(zone.chip));
    if (matching.length > 0) return hottest(matching);
  }
  return null;
}

function hottest(sensors: TemperatureSensor[]): TemperatureSensor {
  return sensors.reduce((a, b) => (b.celsius > a.celsius ? b : a));
}
