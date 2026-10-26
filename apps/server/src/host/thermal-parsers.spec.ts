import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SystemReader } from './system-reader.js';
import { parseMilliCelsius, pickCpuTemperature } from './thermal-parsers.js';

describe('parseMilliCelsius', () => {
  it('reads millidegrees, rounded to a tenth', () => {
    expect(parseMilliCelsius('48250\n')).toBe(48.3);
    expect(parseMilliCelsius('-5000')).toBe(-5);
  });

  it('refuses empty, broken and impossible readings', () => {
    expect(parseMilliCelsius(null)).toBeNull();
    expect(parseMilliCelsius('')).toBeNull();
    expect(parseMilliCelsius('n/a')).toBeNull();
    expect(parseMilliCelsius('-273150')).toBeNull(); // an unwired input
    expect(parseMilliCelsius('255000')).toBeNull();
  });
});

describe('pickCpuTemperature', () => {
  const sensor = (chip: string, celsius: number, label: string | null = null) => ({
    chip,
    label,
    celsius,
    criticalCelsius: null,
  });

  it('prefers the preferred label over hotter inputs of the same chip', () => {
    expect(
      pickCpuTemperature(
        [sensor('coretemp', 61, 'Core 0'), sensor('coretemp', 55, 'Package id 0')],
        [],
      ),
    ).toEqual({ celsius: 55, criticalCelsius: null });
  });

  it('takes Tdie over Tctl (Tctl may be offset)', () => {
    expect(
      pickCpuTemperature([sensor('k10temp', 70, 'Tctl'), sensor('k10temp', 60, 'Tdie')], [])
        ?.celsius,
    ).toBe(60);
  });

  it('takes the hottest input of a chip without labels', () => {
    expect(
      pickCpuTemperature([sensor('cpu_thermal', 44), sensor('cpu_thermal', 47)], [])?.celsius,
    ).toBe(47);
  });

  it('falls back to thermal zones in their order', () => {
    expect(
      pickCpuTemperature([], [sensor('acpitz', 30), sensor('x86_pkg_temp', 52)])?.celsius,
    ).toBe(52);
  });

  it('has nothing to say without a sensor', () => {
    expect(pickCpuTemperature([], [])).toBeNull();
  });
});

describe('SystemReader.cpuTemperature (fixture machines)', () => {
  let root: string;
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'thermal-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('an Intel PC: coretemp "Package id 0" with its critical limit', async () => {
    write('sys/class/hwmon/hwmon0/name', 'acpitz\n');
    write('sys/class/hwmon/hwmon0/temp1_input', '27800\n');
    write('sys/class/hwmon/hwmon3/name', 'coretemp\n');
    write('sys/class/hwmon/hwmon3/temp1_input', '51000\n');
    write('sys/class/hwmon/hwmon3/temp1_label', 'Package id 0\n');
    write('sys/class/hwmon/hwmon3/temp1_crit', '100000\n');
    write('sys/class/hwmon/hwmon3/temp2_input', '56000\n');
    write('sys/class/hwmon/hwmon3/temp2_label', 'Core 0\n');
    expect(await new SystemReader(root).cpuTemperature()).toEqual({
      celsius: 51,
      criticalCelsius: 100,
    });
  });

  it('an AMD PC: k10temp Tctl', async () => {
    write('sys/class/hwmon/hwmon1/name', 'k10temp\n');
    write('sys/class/hwmon/hwmon1/temp1_input', '45125\n');
    write('sys/class/hwmon/hwmon1/temp1_label', 'Tctl\n');
    expect((await new SystemReader(root).cpuTemperature())?.celsius).toBe(45.1);
  });

  it('a Raspberry Pi: the cpu-thermal zone with its critical trip point', async () => {
    write('sys/class/thermal/thermal_zone0/type', 'cpu-thermal\n');
    write('sys/class/thermal/thermal_zone0/temp', '47236\n');
    write('sys/class/thermal/thermal_zone0/trip_point_0_type', 'critical\n');
    write('sys/class/thermal/thermal_zone0/trip_point_0_temp', '110000\n');
    write('sys/class/thermal/cooling_device0/type', 'gpio-fan\n');
    expect(await new SystemReader(root).cpuTemperature()).toEqual({
      celsius: 47.2,
      criticalCelsius: 110,
    });
  });

  it('never reads chips it does not know (drivetemp may wake a sleeping disk)', async () => {
    write('sys/class/hwmon/hwmon2/name', 'drivetemp\n');
    write('sys/class/hwmon/hwmon2/temp1_input', '33000\n');
    write('sys/class/hwmon/hwmon4/name', 'nvme\n');
    write('sys/class/hwmon/hwmon4/temp1_input', '38000\n');
    expect(await new SystemReader(root).cpuTemperature()).toBeNull();
  });

  it('a VM: no sensors at all', async () => {
    write('sys/class/thermal/cooling_device0/type', 'Processor\n');
    expect(await new SystemReader(root).cpuTemperature()).toBeNull();
  });
});
